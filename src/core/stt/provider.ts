/**
 * Интерфейс STT-провайдера (G3-1). Реальный провайдер — этап G4+;
 * сейчас контракт + детерминированный мок для тестов.
 */

export interface Transcription {
  text: string;
  lang: string;
  segments?: { startMs: number; endMs: number; text: string }[];
}

export interface SttProvider {
  readonly name: string;
  transcribe(buffer: Buffer, langHint?: string): Promise<Transcription>;
}

/**
 * Детерминированный мок: текст из переданного скрипта (функция от буфера).
 * Позволяет тестам задавать точные ответы и ошибки без сети.
 */
export class MockSttProvider implements SttProvider {
  readonly name = "mock";

  constructor(
    private readonly script: (buffer: Buffer, langHint?: string) => Transcription | Error,
  ) {}

  transcribe(buffer: Buffer, langHint?: string): Promise<Transcription> {
    const out = this.script(buffer, langHint);
    if (out instanceof Error) return Promise.reject(out);
    return Promise.resolve(out);
  }
}
