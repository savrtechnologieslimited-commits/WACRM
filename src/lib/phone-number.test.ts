import { describe, expect, it } from 'vitest';
import {
  isValidPhoneNumberInput,
  parsePhoneWithRepeatedCallingCode,
  parseValidPhoneNumber,
} from './phone-number';

describe('phone number validation', () => {
  it('uses India by default and requires exactly ten valid national digits', () => {
    expect(parseValidPhoneNumber('9876543210')).toBe('+919876543210');
    expect(isValidPhoneNumberInput('9876543210')).toBe(true);
    expect(isValidPhoneNumberInput('987654321')).toBe(false);
    expect(isValidPhoneNumberInput('09876543210')).toBe(false);
    expect(isValidPhoneNumberInput('98765432101')).toBe(false);
  });

  it('accepts valid international phone numbers', () => {
    expect(parseValidPhoneNumber('+14155552671')).toBe('+14155552671');
    expect(parseValidPhoneNumber('4155552671', 'US')).toBe('+14155552671');
  });

  it('removes a repeated calling code only when the remaining number is valid', () => {
    expect(parsePhoneWithRepeatedCallingCode('919876543210', 'IN')).toEqual({
      nationalNumber: '9876543210',
      phoneNumber: '+919876543210',
    });
    expect(parsePhoneWithRepeatedCallingCode('9198765432', 'IN')).toBeNull();
    expect(parsePhoneWithRepeatedCallingCode('14155552671', 'US')).toEqual({
      nationalNumber: '4155552671',
      phoneNumber: '+14155552671',
    });
  });
});
