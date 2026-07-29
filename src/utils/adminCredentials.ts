const USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/;

export function normalizeAdminUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function validateAdminUsername(username: string): string | null {
  const normalized = normalizeAdminUsername(username);
  if (!normalized) return 'Username is required.';
  if (!USERNAME_PATTERN.test(normalized)) {
    return 'Username must be 3–32 characters and contain only lowercase letters, numbers, or underscores.';
  }
  return null;
}

export function validateAdminPassword(password: string): string | null {
  if (!password || typeof password !== 'string') return 'Password is required.';
  if (password.length < 10) return 'Password must be at least 10 characters.';
  if (password.length > 128) return 'Password must be at most 128 characters.';
  if (!/[a-z]/i.test(password)) return 'Password must include at least one letter.';
  if (!/[0-9]/.test(password)) return 'Password must include at least one number.';
  return null;
}
