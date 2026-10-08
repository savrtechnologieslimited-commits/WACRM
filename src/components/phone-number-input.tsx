'use client';

import { useEffect, useState } from 'react';
import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js';
import isoCountries from 'i18n-iso-countries';

import { Input } from '@/components/ui/input';
import {
  isValidPhoneNumberInput,
  parsePhoneWithRepeatedCallingCode,
} from '@/lib/phone-number';

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
export const PHONE_COUNTRIES = getCountries()
  .map((code) => ({
    code,
    isoCode: isoCountries.alpha2ToAlpha3(code) ?? code,
    name: countryNames.of(code) ?? code,
    callingCode: getCountryCallingCode(code),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

export function PhoneCountrySelect({
  value,
  onChange,
  disabled = false,
}: {
  value: CountryCode;
  onChange: (value: CountryCode) => void;
  disabled?: boolean;
}) {
  return (
    <select
      aria-label="Country calling code"
      className="h-10 w-28 shrink-0 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      value={value}
      onChange={(event) => onChange(event.target.value as CountryCode)}
      disabled={disabled}
    >
      {PHONE_COUNTRIES.map((item) => (
        <option key={item.code} value={item.code}>
          {item.isoCode} (+{item.callingCode})
        </option>
      ))}
    </select>
  );
}

interface PhoneNumberInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  autoComplete?: string;
  onBlur?: () => void;
}

export function PhoneNumberInput({
  id,
  value,
  onChange,
  required = false,
  disabled = false,
  autoComplete = 'tel-national',
  onBlur,
}: PhoneNumberInputProps) {
  const [country, setCountry] = useState<CountryCode>('IN');
  const [nationalNumber, setNationalNumber] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!value) {
      setNationalNumber('');
      return;
    }
    if (value.startsWith('+')) {
      const parsed = parsePhoneNumberFromString(value);
      if (parsed) {
        if (parsed.country) setCountry(parsed.country);
        const digits = value.replace(/\D/g, '');
        const nationalDigits = digits.startsWith(parsed.countryCallingCode)
          ? digits.slice(parsed.countryCallingCode.length)
          : parsed.nationalNumber;
        const repeatedCode = parsed.country
          ? parsePhoneWithRepeatedCallingCode(nationalDigits, parsed.country)
          : null;
        setNationalNumber(repeatedCode?.nationalNumber ?? nationalDigits);
        if (repeatedCode && value !== repeatedCode.phoneNumber) {
          onChange(repeatedCode.phoneNumber);
        }
        return;
      }
    }
    setNationalNumber(value.replace(/\D/g, ''));
  }, [value]);

  const isEmpty = nationalNumber.trim().length === 0;
  const invalid = touched && (isEmpty ? required : !isValidPhoneNumberInput(value, country));
  const countryName = PHONE_COUNTRIES.find((item) => item.code === country)?.name ?? country;
  const errorId = `${id}-error`;

  function updateNumber(next: string) {
    if (next.trim().startsWith('+')) {
      const parsed = parsePhoneNumberFromString(next);
      if (parsed) {
        const digits = next.replace(/\D/g, '');
        setCountry(parsed.country ?? country);
        setNationalNumber(
          digits.startsWith(parsed.countryCallingCode)
            ? digits.slice(parsed.countryCallingCode.length)
            : parsed.nationalNumber,
        );
        setTouched(false);
        onChange(`+${digits}`);
        return;
      }
    }
    const repeatedCode = parsePhoneWithRepeatedCallingCode(next, country);
    if (repeatedCode) {
      setNationalNumber(repeatedCode.nationalNumber);
      setTouched(false);
      onChange(repeatedCode.phoneNumber);
      return;
    }
    setNationalNumber(next);
    setTouched(false);
    const digits = next.replace(/\D/g, '');
    onChange(next.trim() ? `+${getCountryCallingCode(country)}${digits}` : '');
  }

  function updateCountry(next: CountryCode) {
    setCountry(next);
    setTouched(false);
    const digits = nationalNumber.replace(/\D/g, '');
    onChange(
      nationalNumber.trim()
        ? `+${getCountryCallingCode(next)}${digits}`
        : '',
    );
  }

  return (
    <div>
      <div className="flex gap-2">
        <PhoneCountrySelect value={country} onChange={updateCountry} disabled={disabled} />
        <Input
          id={id}
          type="tel"
          inputMode="tel"
          autoComplete={autoComplete}
          value={nationalNumber}
          onChange={(event) => updateNumber(event.target.value)}
          onBlur={() => {
            setTouched(true);
            onBlur?.();
          }}
          required={required}
          disabled={disabled}
          aria-invalid={invalid}
          aria-describedby={invalid ? errorId : undefined}
          placeholder="Enter phone number"
        />
      </div>
      {invalid ? (
        <p id={errorId} className="mt-1 text-xs text-destructive" role="alert">
          {isEmpty
            ? 'Enter a phone number.'
            : `Enter a valid ${countryName} phone number.`}
        </p>
      ) : null}
    </div>
  );
}
