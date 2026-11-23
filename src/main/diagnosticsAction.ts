let exporter: (() => Promise<string | null>) | null = null

export function setDiagnosticsExporter(fn: () => Promise<string | null>): void {
  exporter = fn
}

export function runDiagnosticsExport(): Promise<string | null> {
  return exporter ? exporter() : Promise.resolve(null)
}
