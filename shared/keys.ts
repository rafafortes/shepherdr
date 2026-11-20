// Words typed into a CLI's pane must stay words: a relayed message can carry ESC and other control bytes that a TUI
// reads as keys (cancelling a prompt or picking a menu option). Only what enters the pane is cleaned; the chat keeps
// the original text.

// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC introduces every sequence a TUI reads as a key
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g // ESC [ parameters intermediates final byte
// biome-ignore lint/suspicious/noControlCharactersInRegex: BEL and ST end an OSC; matching them needs their bytes
const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g // ESC ] ... BEL or ST (ESC \)
// biome-ignore lint/suspicious/noControlCharactersInRegex: a lone ESC is still a control byte, even outside a sequence
const ESC_SEQUENCE = /\x1b[ -/]*[0-~]/g // any other ESC sequence, through its final byte
// biome-ignore lint/suspicious/noControlCharactersInRegex: C0/C1 are exactly the bytes this function removes
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g // C0 except tab/LF/CR, DEL and C1

/** Strip terminal controls before text is typed into a pane. Letters, spaces, tabs and line breaks survive; CSI and OSC
 *  go with their terminators so their payload cannot be read as words. Ordinary text, including non-ASCII, is unchanged. */
export function stripControl(text: string): string {
  return text.replace(CSI, '').replace(OSC, '').replace(ESC_SEQUENCE, '').replace(CONTROL, '')
}
