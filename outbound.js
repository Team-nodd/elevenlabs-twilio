import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import Twilio from "twilio";

// Load environment variables from .env file
dotenv.config();

const {
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
} = process.env;

if (
  !ELEVENLABS_API_KEY ||
  !ELEVENLABS_AGENT_ID ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER
) {
  console.error("Missing required environment variables");
  throw new Error("Missing required environment variables");
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = process.env.PORT || 8000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Root route for health check
app.get("/", (req, res) => {
  res.send({ message: "Server is running" });
});

// Initialize Twilio client
const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Helper function to get signed URL for authenticated conversations
async function getSignedUrl() {
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
      {
        method: "GET",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get signed URL: ${response.statusText}`);
    }

    const data = await response.json();
    return data.signed_url;
  } catch (error) {
    console.error("Error getting signed URL:", error);
    throw error;
  }
}

// Route to initiate outbound calls
app.post("/outbound-call", async (req, res) => {
  const { number, prompt, first_message } = req.body;

  if (!number) {
    return res.status(400).send({ error: "Phone number is required" });
  }

  try {
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: number,
      url: `https://${req.headers.host}/outbound-call-twiml?prompt=${encodeURIComponent(
        prompt
      )}&first_message=${encodeURIComponent(first_message)}`,
    });

    res.send({
      success: true,
      message: "Call initiated",
      callSid: call.sid,
    });
  } catch (error) {
    console.error("Error initiating outbound call:", error);
    res.status(500).send({
      success: false,
      error: "Failed to initiate call",
    });
  }
});

// TwiML route for outbound calls
app.all("/outbound-call-twiml", (req, res) => {
  const prompt = req.query.prompt || "";
  const first_message = req.query.first_message || "";

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${req.headers.host}/outbound-media-stream">
            <Parameter name="prompt" value="${prompt}" />
            <Parameter name="first_message" value="${first_message}" />
          </Stream>
        </Connect>
      </Response>`;

  res.type("text/xml").send(twimlResponse);
});

// WebSocket upgrade handler
server.on("upgrade", (request, socket, head) => {
  if (request.url.startsWith("/outbound-media-stream")) {
    wss.handleUpgrade(request, socket, head, ws => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// WebSocket connection handler
wss.on("connection", (ws, req) => {
  console.info("[Server] Twilio connected to outbound media stream");

  let streamSid = null;
  let callSid = null;
  let elevenLabsWs = null;
  let customParameters = null;

  ws.on("error", console.error);

  const setupElevenLabs = async () => {
    try {
      const signedUrl = await getSignedUrl();
      elevenLabsWs = new WebSocket(signedUrl);

      elevenLabsWs.on("open", () => {
        console.log("[ElevenLabs] Connected to Conversational AI");

        // Send initial configuration with prompt and first message
        const initialConfig = {
          type: "conversation_initiation_client_data",
          conversation_config_override: {
            agent: {
              prompt: {
                prompt:
                  customParameters?.prompt ||
                  "you are a gary from the phone store",
              },
              first_message:
                customParameters?.first_message ||
                "hey there! how can I help you today?",
            },
          },
        };

        console.log(
          "[ElevenLabs] Sending initial config with prompt:",
          initialConfig.conversation_config_override.agent.prompt.prompt
        );

        elevenLabsWs.send(JSON.stringify(initialConfig));
      });

      elevenLabsWs.on("message", data => {
        try {
          const message = JSON.parse(data);

          switch (message.type) {
            case "conversation_initiation_metadata":
              console.log("[ElevenLabs] Received initiation metadata");
              break;
            case "audio":
              if (streamSid) {
                if (message.audio?.chunk) {
                  const audioData = {
                    event: "media",
                    streamSid,
                    media: {
                      payload: message.audio.chunk,
                    },
                  };
                  ws.send(JSON.stringify(audioData));
                } else if (message.audio_event?.audio_base_64) {
                  const audioData = {
                    event: "media",
                    streamSid,
                    media: {
                      payload: message.audio_event.audio_base_64,
                    },
                  };
                  ws.send(JSON.stringify(audioData));
                }
              } else {
                console.log("[ElevenLabs] Received audio but no StreamSid yet");
              }
              break;
            case "interruption":
              if (streamSid) {
                ws.send(
                  JSON.stringify({
                    event: "clear",
                    streamSid,
                  })
                );
              }
              break;
            case "ping":
              if (message.ping_event?.event_id) {
                elevenLabsWs.send(
                  JSON.stringify({
                    type: "pong",
                    event_id: message.ping_event.event_id,
                  })
                );
              }
              break;
            case "agent_response":
              console.log(
                `[Twilio] Agent response: ${message.agent_response_event?.agent_response}`
              );
              break;
            case "user_transcript":
              console.log(
                `[Twilio] User transcript: ${message.user_transcription_event?.user_transcript}`
              );
              break;
            default:
              console.log(
                `[ElevenLabs] Unhandled message type: ${message.type}`
              );
          }
        } catch (error) {
          console.error("[ElevenLabs] Error processing message:", error);
        }
      });

      elevenLabsWs.on("error", error => {
        console.error("[ElevenLabs] WebSocket error:", error);
      });

      elevenLabsWs.on("close", () => {
        console.log("[ElevenLabs] Disconnected");
      });
    } catch (error) {
      console.error("[ElevenLabs] Setup error:", error);
    }
  };

  setupElevenLabs();

  ws.on("message", message => {
    try {
      const msg = JSON.parse(message);
      if (msg.event !== "media") {
        console.log(`[Twilio] Received event: ${msg.event}`);
      }

      switch (msg.event) {
        case "start":
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          customParameters = msg.start.customParameters;
          console.log(
            `[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`
          );
          console.log("[Twilio] Start parameters:", customParameters);
          break;
        case "media":
          if (elevenLabsWs?.readyState === WebSocket.OPEN) {
            const audioMessage = {
              user_audio_chunk: Buffer.from(
                msg.media.payload,
                "base64"
              ).toString("base64"),
            };
            elevenLabsWs.send(JSON.stringify(audioMessage));
          }
          break;
        case "stop":
          console.log(`[Twilio] Stream ${streamSid} ended`);
          if (elevenLabsWs?.readyState === WebSocket.OPEN) {
            elevenLabsWs.close();
          }
          break;
        default:
          console.log(`[Twilio] Unhandled event: ${msg.event}`);
      }
    } catch (error) {
      console.error("[Twilio] Error processing message:", error);
    }
  });

  ws.on("close", () => {
    console.log("[Twilio] Client disconnected");
    if (elevenLabsWs?.readyState === WebSocket.OPEN) {
      elevenLabsWs.close();
    }
  });
});

server.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
});