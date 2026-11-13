export function resolveBridgeDestination(
  value: FormDataEntryValue | null,
  requestUrl: string
): URL | null {
  const fallback = new URL('/dashboard', requestUrl);
  if (value === null || value === '') return fallback;
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\')
  ) {
    return null;
  }

  try {
    const decodedValue = decodeURIComponent(value);
    if (
      decodedValue.startsWith('//') ||
      decodedValue.startsWith('/\\') ||
      decodedValue.includes('\\')
    ) {
      return null;
    }

    const destination = new URL(value, requestUrl);
    return destination.origin === new URL(requestUrl).origin
      ? destination
      : null;
  } catch {
    return null;
  }
}
