declare module "pdf-parse/lib/pdf-parse.js" {
  const pdfParse: (data: Uint8Array, options?: Record<string, unknown>) => Promise<{ text: string; numpages: number }>;
  export default pdfParse;
}
