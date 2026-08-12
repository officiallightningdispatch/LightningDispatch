/**
 * Ambient types for the Bun runtime surface used by serve.ts (the production
 * server wrapper). Bun executes these files directly, but the project's
 * tsconfig types are ["vite/client"] so the Bun globals are otherwise unknown
 * to tsc. Declarations mirror the Bun API shapes we actually use; they are
 * type-only and have no runtime presence.
 */
interface ImportMeta {
  /** Absolute path of the current module's directory (Bun extension). */
  dir: string;
}

declare namespace Bun {
  function file(path: string): {
    exists(): Promise<boolean>;
  } & BodyInit;
  function sleep(ms: number): Promise<void>;
  function serve(opts: {
    port: number;
    hostname: string;
    fetch(req: Request): Response | Promise<Response>;
  }): unknown;
  const $: {
    (strings: TemplateStringsArray, ...values: unknown[]): {
      quiet(): { nothrow(): Promise<{ exitCode: number }> };
    };
  };
}
