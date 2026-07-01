import FormData from "form-data";
import { createReadStream } from "node:fs";

import { requireApiKey } from "../config/env.js";
import type { ScribeTranscript } from "../types/index.js";
import { ScribeError } from "./errors.js";

export const SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text";

export interface ScribeCallOptions {
  language?: string | undefined;
  numSpeakers?: number | undefined;
  apiKey?: string | undefined;
}

/** Upload audio to ElevenLabs Scribe and return the transcript payload. */
export async function callScribe(
  audioPath: string,
  options: ScribeCallOptions = {},
): Promise<ScribeTranscript> {
  const apiKey = options.apiKey ?? requireApiKey();
  const form = new FormData();

  form.append("file", createReadStream(audioPath));
  form.append("model_id", "scribe_v1");
  form.append("diarize", "true");
  form.append("tag_audio_events", "true");
  form.append("timestamps_granularity", "word");

  if (options.language) {
    form.append("language_code", options.language);
  }
  if (options.numSpeakers) {
    form.append("num_speakers", String(options.numSpeakers));
  }

  const response = await fetch(SCRIBE_URL, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      ...form.getHeaders(),
    },
    body: form as unknown as BodyInit,
  });

  const bodyText = await response.text();

  if (!response.ok) {
    throw new ScribeError(
      `Scribe returned ${response.status}: ${bodyText.slice(0, 500)}`,
      response.status,
    );
  }

  return JSON.parse(bodyText) as ScribeTranscript;
}

/** Verify an API key with a lightweight user endpoint call. */
export async function verifyApiKey(apiKey: string): Promise<number> {
  const response = await fetch("https://api.elevenlabs.io/v1/user", {
    headers: { "xi-api-key": apiKey },
  });
  return response.status;
}
