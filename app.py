"""Runs a local server for the Logn MUN committee page, including one small
backend route (/api/speech) that turns an AI Delegate's speech text into
spoken audio using the ElevenLabs text-to-speech API."""

import json
import os
import ssl
import urllib.error
import urllib.request
from errno import EADDRINUSE
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent
VOICES_CONFIG_PATH = PROJECT_DIR / "voices.json"
ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"


# Loads ELEVENLABS_API_KEY from a local .env file, if one exists, without
# needing any extra pip packages. Real API keys should only ever live in
# this untracked file -- never inside the JS/HTML that visitors download.
def load_dotenv(path: Path) -> None:
    if not path.exists():
        return

    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


# Reads the country/gender -> ElevenLabs voice_id lookup table so a speech
# request knows which configured voice to use for each delegate.
def load_voice_config() -> dict:
    if not VOICES_CONFIG_PATH.exists():
        return {}

    with VOICES_CONFIG_PATH.open(encoding="utf-8") as config_file:
        return json.load(config_file)


# Picks a voice_id for the requested country/gender/accent combination.
# Falls back to the gender-only default voice when no accented voice is
# configured yet for that country (or the accent checkbox was left off).
def resolve_voice_id(voice_config, country, gender, use_accent):
    gender = gender if gender in ("male", "female") else "female"

    if use_accent:
        accented_voice = voice_config.get("accented", {}).get(country, {}).get(gender)
        if accented_voice:
            return accented_voice

    return voice_config.get("default", {}).get(gender) or None


# Builds an SSL context for the ElevenLabs request. Uses the certifi
# package's certificate bundle when it is installed, since many macOS
# Python installs (especially the python.org installer) don't ship a
# working set of root certificates, which causes a
# "CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate"
# error on this and every other HTTPS request. Falls back to Python's
# normal defaults if certifi isn't installed.
def build_ssl_context() -> ssl.SSLContext:
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


# Calls the ElevenLabs API and returns the raw MP3 audio bytes for the
# given speech text and voice_id.
def synthesize_speech(text: str, voice_id: str, api_key: str) -> bytes:
    url = ELEVENLABS_TTS_URL.format(voice_id=voice_id)
    payload = json.dumps({
        "text": text,
        "model_id": "eleven_multilingual_v2",
    }).encode("utf-8")

    request = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "xi-api-key": api_key,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
    )

    with urllib.request.urlopen(request, timeout=60, context=build_ssl_context()) as response:
        return response.read()


# Serves the static committee site (unchanged) and adds one small API
# route, POST /api/speech, that turns AI Delegate speech text into audio.
class LognMunRequestHandler(SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/api/speech":
            self.send_error(404, "Not found")
            return

        self._handle_speech_request()

    # Reads the {text, country, gender, accent} JSON body, resolves which
    # ElevenLabs voice to use, and streams back the generated MP3 audio.
    def _handle_speech_request(self):
        content_length = int(self.headers.get("Content-Length", 0) or 0)

        try:
            body = json.loads(self.rfile.read(content_length) or b"{}")
        except json.JSONDecodeError:
            self._send_json_error(400, "The request body was not valid JSON.")
            return

        text = (body.get("text") or "").strip()
        country = body.get("country") or ""
        gender = body.get("gender") or "female"
        use_accent = bool(body.get("accent"))

        if not text:
            self._send_json_error(400, "No speech text was provided.")
            return

        api_key = os.environ.get("ELEVENLABS_API_KEY")
        if not api_key:
            self._send_json_error(
                500,
                "ELEVENLABS_API_KEY is not set. Add it to a .env file in this "
                "project folder (see .env.example) and restart the server.",
            )
            return

        voice_config = load_voice_config()
        voice_id = resolve_voice_id(voice_config, country, gender, use_accent)
        if not voice_id:
            self._send_json_error(
                500,
                f"No ElevenLabs voice_id is configured yet for {country} "
                f"({gender}). Add one in voices.json.",
            )
            return

        try:
            audio_bytes = synthesize_speech(text, voice_id, api_key)
        except urllib.error.HTTPError as error:
            details = error.read().decode("utf-8", errors="ignore")
            self._send_json_error(error.code, f"ElevenLabs rejected the request: {details}")
            return
        except urllib.error.URLError as error:
            self._send_json_error(502, f"Could not reach ElevenLabs: {error.reason}")
            return

        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(audio_bytes)))
        self.end_headers()
        self.wfile.write(audio_bytes)

    # Sends a small JSON error body so committee.js can show a real message
    # instead of a generic browser network error.
    def _send_json_error(self, status: int, message: str) -> None:
        payload = json.dumps({"error": message}).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


# Finds a free local port without stopping another program that is already running.
def create_server() -> ThreadingHTTPServer:
    for port in range(8000, 8010):
        try:
            return ThreadingHTTPServer(("", port), LognMunRequestHandler)
        except OSError as error:
            if error.errno != EADDRINUSE:
                raise

    raise OSError("Ports 8000 through 8009 are already in use.")


# Starts a local server so the static committee page can be opened in a browser.
def run_server() -> None:
    load_dotenv(PROJECT_DIR / ".env")
    httpd = create_server()

    print(f"Logn MUN is running at http://localhost:{httpd.server_port}")
    if not os.environ.get("ELEVENLABS_API_KEY"):
        print("Note: ELEVENLABS_API_KEY is not set yet, so AI speech audio will not work until it is.")
    print("Press Ctrl+C to stop the server.")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        httpd.server_close()


# Runs the server only when this file is started directly.
if __name__ == "__main__":
    run_server()
