import asyncio
import base64
import json
from fastapi import WebSocket
from elevenlabs.conversational_ai.conversation import AudioInterface
from starlette.websockets import WebSocketDisconnect, WebSocketState
import logging


 # Configure logging if not already configured
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class TwilioAudioInterface(AudioInterface):
    def __init__(self, websocket: WebSocket):
        self.websocket = websocket
        self.input_callback = None
        self.stream_sid = None
        self.loop = asyncio.get_event_loop()

    def start(self, input_callback):
        print("AudioInterface: start called")
        self.input_callback = input_callback

    def stop(self):
        self.input_callback = None
        self.stream_sid = None

    def output(self, audio: bytes):
        """
        This method should return quickly and not block the calling thread.
        """

        asyncio.run_coroutine_threadsafe(self.send_audio_to_twilio(audio), self.loop)

    def interrupt(self):
        asyncio.run_coroutine_threadsafe(self.send_clear_message_to_twilio(), self.loop)


    async def send_audio_to_twilio(self, audio: bytes):
        if self.stream_sid:
            try:
                audio_payload = base64.b64encode(audio).decode("utf-8")
                audio_delta = {
                    "event": "media",
                    "streamSid": self.stream_sid,
                    "media": {"payload": audio_payload},
                }

                logger.info(f"Preparing to send audio. Stream SID: {self.stream_sid}")
                logger.debug(f"Audio payload size (bytes before encoding): {len(audio)}")
                logger.debug(f"Base64 audio payload size (chars): {len(audio_payload)}")
                
                if self.websocket.application_state == WebSocketState.CONNECTED:
                    await self.websocket.send_text(json.dumps(audio_delta))
                    logger.info("Audio data sent successfully to Twilio.")
                else:
                    logger.warning("WebSocket not connected. Skipping audio send.")
            
            except WebSocketDisconnect:
                logger.error("WebSocketDisconnect: Connection closed while trying to send audio.")
            except RuntimeError as e:
                logger.error(f"RuntimeError: {e}")
            except Exception as e:
                logger.exception(f"Unexpected error while sending audio: {e}")
        else:
            logger.warning("No stream SID available. Audio not sent.")


    async def send_clear_message_to_twilio(self):
        if self.stream_sid:
            clear_message = {"event": "clear", "streamSid": self.stream_sid}
            try:
                if self.websocket.application_state == WebSocketState.CONNECTED:
                    await self.websocket.send_text(json.dumps(clear_message))
            except (WebSocketDisconnect, RuntimeError):
                pass

    async def handle_twilio_message(self, data):
        event_type = data.get("event")
        if event_type == "start":
            self.stream_sid = data["start"]["streamSid"]
        elif event_type == "media" and self.input_callback:

            print("Media received:", len(data["media"]["payload"]))

            audio_data = base64.b64decode(data["media"]["payload"])

            print(f"Audio frame size: {len(audio_data)} bytes")
            self.input_callback(audio_data)