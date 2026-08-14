import { copyFile, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { fail } from "./errors.js"

export const DEFAULT_OCR_LANGUAGES = Object.freeze(["eng", "chi_sim"])

const LANGUAGE_MODEL_SPECIFIERS = Object.freeze({
  eng: "@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
  chi_sim: "@tesseract.js-data/chi_sim/4.0.0_best_int/chi_sim.traineddata.gz",
})

export function createOcrSession(options = {}) {
  const languages = normalizeLanguages(options.languages)
  const injectedRecognize = typeof options.recognize === "function" ? options.recognize : undefined
  let workerPromise
  let languageDirectory
  let terminated = false

  const loadWorker = async () => {
    if (injectedRecognize) return undefined
    if (!workerPromise) {
      workerPromise = (async () => {
        languageDirectory = await prepareLanguageDirectory(languages)
        const { createWorker, OEM } = await import("tesseract.js")
        try {
          return await createWorker(languages, OEM.LSTM_ONLY, {
            langPath: languageDirectory,
            gzip: true,
            cacheMethod: "none",
            logger: () => {},
            errorHandler: () => {},
          })
        } catch (error) {
          await cleanupLanguageDirectory(languageDirectory)
          languageDirectory = undefined
          throw error
        }
      })()
    }
    return workerPromise
  }

  return {
    languages,
    async recognize(buffer, context = {}) {
      if (terminated) fail("SOURCE_PARSE_FAILED", "The OCR worker was used after it was closed.")
      context.signal?.throwIfAborted()
      if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
        fail("SOURCE_PARSE_FAILED", "OCR input must be an image buffer.")
      }
      try {
        const pending = injectedRecognize
          ? injectedRecognize(buffer, context)
          : (await loadWorker()).recognize(buffer, { rotateAuto: true })
        const result = pending && typeof pending.then === "function"
          ? await withAbortSignal(pending, context.signal)
          : pending
        context.signal?.throwIfAborted()
        return normalizeOcrResult(result)
      } catch (error) {
        fail("SOURCE_PARSE_FAILED", "OCR could not recognize the image.", {
          details: {
            context,
            reason: error instanceof Error ? error.message : String(error),
          },
        })
      }
    },
    async terminate() {
      if (terminated) return
      terminated = true
      try {
        const worker = workerPromise ? await workerPromise.catch(() => undefined) : undefined
        await worker?.terminate()
      } finally {
        await cleanupLanguageDirectory(languageDirectory)
        languageDirectory = undefined
      }
    },
  }
}

function withAbortSignal(promise, signal) {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("OCR operation was cancelled."))
    signal.addEventListener("abort", onAbort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
  })
}

function normalizeLanguages(value) {
  const requested = Array.isArray(value) && value.length > 0 ? value : DEFAULT_OCR_LANGUAGES
  const languages = [...new Set(requested.map((language) => String(language).trim()).filter(Boolean))]
  for (const language of languages) {
    if (!LANGUAGE_MODEL_SPECIFIERS[language]) {
      fail("SOURCE_PARSE_FAILED", `Bundled OCR language is not available: ${language}`)
    }
  }
  return languages
}

async function prepareLanguageDirectory(languages) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "llm-wiki-ocr-"))
  try {
    for (const language of languages) {
      const source = fileURLToPath(import.meta.resolve(LANGUAGE_MODEL_SPECIFIERS[language]))
      await copyFile(source, path.join(directory, `${language}.traineddata.gz`))
    }
    return directory
  } catch (error) {
    await cleanupLanguageDirectory(directory)
    fail("SOURCE_PARSE_FAILED", "Bundled OCR language data is unavailable.", {
      details: { reason: error instanceof Error ? error.message : String(error) },
    })
  }
}

async function cleanupLanguageDirectory(directory) {
  if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {})
}

function normalizeOcrResult(result) {
  const data = result?.data ?? result ?? {}
  const rawText = typeof data === "string" ? data : data.text
  const text = String(rawText ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim()
  const confidence = Number(data?.confidence)
  return {
    text,
    ...(Number.isFinite(confidence) ? { confidence } : {}),
  }
}
