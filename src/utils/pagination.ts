export interface PaginationParams {
  page: number;
  limit: number;
  skip: number;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export function parsePagination(query: Record<string, unknown>, defaults?: { page?: number; limit?: number }): PaginationParams {
  const defaultPage = defaults?.page ?? 1;
  const defaultLimit = defaults?.limit ?? 20;

  const rawPage = Number(query.page ?? defaultPage);
  const rawLimit = Number(query.limit ?? defaultLimit);

  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : defaultPage;
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(Math.floor(rawLimit), 100) : defaultLimit;

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
}

export function buildPaginationMeta(total: number, page: number, limit: number): PaginationMeta {
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

export function paginatedResponse<T>(items: T[], total: number, page: number, limit: number) {
  return {
    items,
    pagination: buildPaginationMeta(total, page, limit),
  };
}

export function sanitizeSearch(raw: unknown, maxLength = 64): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, maxLength).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
