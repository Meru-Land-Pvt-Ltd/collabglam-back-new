import type { Request } from "express";
import { z } from "zod";
import { Validator } from "../validation/Validator"; // adjust path

export type Pagination = {
  page: number;
  limit: number;
  skip: number;
};

export type PaginationMeta = Pagination & {
  total: number;
  totalPages: number;
};

const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).default(10)
});

type PaginationQuery = z.output<typeof PaginationQuerySchema>;

export const PaginationUtil = {
  fromReq(
    req: Request,
    opts?: { defaultLimit?: number; maxLimit?: number }
  ): Pagination {
    const defaultLimit = opts?.defaultLimit ?? 10;
    const maxLimit = opts?.maxLimit ?? 100;

    const parsed = Validator.parse(PaginationQuerySchema, {
      page: req.query.page,
      limit: req.query.limit ?? defaultLimit
    }) as PaginationQuery;

    const page = parsed.page;
    const limit = Math.min(parsed.limit, maxLimit);
    const skip = (page - 1) * limit;

    return { page, limit, skip };
  },

  meta(p: Pagination, total: number): PaginationMeta {
    const safeTotal = Number.isFinite(total) && total >= 0 ? total : 0;
    const totalPages = Math.max(Math.ceil(safeTotal / p.limit), 1);

    return {
      ...p,
      total: safeTotal,
      totalPages
    };
  }
};
