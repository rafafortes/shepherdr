// Talk to type: the screen records (the browser's own recording), the recording goes to the machine that serves
// Shepherdr, and that machine writes it down with whisper.cpp and sends the words back. The audio is never kept.

/** a recording goes up at most this big: minutes of speech, and a ceiling a phone can't fill */
export const DICTATE_CAP = 20 * 1024 * 1024

export const DICTATE_TOO_LONG = 'That recording is too long: 20 MB at most. Talk to type a shorter one.'

/** the way to write it down, as Settings keeps it (dictate.model, dictate.language) */
export interface DictateWays {
  /** whisper.cpp's own flags */
  binary: string
  /** the model file, a multilingual one: it is told the language, or works it out itself */
  model: string
  /** whisper's language code, or auto */
  lang: string
  /** ffmpeg's command, when it is not the one on PATH (a test's, or a machine that keeps it elsewhere) */
  ffmpeg?: string
}

export type DictateAnswer = { text: string } | { error: string }
