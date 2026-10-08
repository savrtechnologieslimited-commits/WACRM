import {
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js';

export function parseValidPhoneNumber(
  value: string,
  defaultCountry: CountryCode = 'IN',
): string | null {
  const raw = value.trim();
  const phone = parsePhoneNumberFromString(raw, defaultCountry);
  if (!phone?.isValid()) return null;

  if (phone.country === 'IN') {
    const digits = raw.replace(/\D/g, '');
    const callingCode = getCountryCallingCode('IN');
    const nationalDigits =
      raw.startsWith('+') && digits.startsWith(callingCode)
        ? digits.slice(callingCode.length)
        : digits;
    if (nationalDigits.length !== 10) return null;
  }

  return phone.number;
}

export function isValidPhoneNumberInput(
  value: string,
  defaultCountry: CountryCode = 'IN',
): boolean {
  return parseValidPhoneNumber(value, defaultCountry) !== null;
}

export function parsePhoneWithRepeatedCallingCode(
  value: string,
  country: CountryCode,
): { nationalNumber: string; phoneNumber: string } | null {
  const digits = value.replace(/\D/g, '');
  const callingCode = getCountryCallingCode(country);
  if (!digits.startsWith(callingCode)) return null;

  const nationalNumber = digits.slice(callingCode.length);
  const phoneNumber = parseValidPhoneNumber(
    `+${callingCode}${nationalNumber}`,
    country,
  );
  return phoneNumber ? { nationalNumber, phoneNumber } : null;
}
