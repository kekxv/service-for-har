declare module './saz-converter.js' {
  export function convertSazToHar(sazPath: string, harPath: string, encoding?: string): Promise<void>;
}