const EMAIL_PATTERN =
  /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const MAX_EMAIL_LENGTH = 254;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const normalized = input.trim().toLowerCase();
  return normalized.length === 0 ? null : normalized;
}

export function isValidEmail(email: string): boolean {
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email);
}

export function validatePassword(
  input: unknown,
  email?: string | null,
): boolean {
  if (typeof input !== "string") {
    return false;
  }
  if (input.length < MIN_PASSWORD_LENGTH || input.length > MAX_PASSWORD_LENGTH) {
    return false;
  }
  if (email && input.toLowerCase().includes(email.toLowerCase())) {
    return false;
  }
  return true;
}
