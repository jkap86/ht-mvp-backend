// Helper to safely get string parameter from Express params
export function getParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] || '';
  }
  return value || '';
}

export function parseIntParam(value: string | string[] | undefined): number {
  return parseInt(getParam(value), 10);
}
