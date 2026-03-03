// src/auth/influencerAuth.ts
import type { Request, Response, NextFunction } from "express";
import * as jwt from "jsonwebtoken";

import { ApiError, InternalError, ForbiddenError } from "../core/http/ApiError";
import { HttpStatus } from "../core/http/HttpStatus";
import { ErrorCodes } from "../core/http/errorCodes";

type InfluencerJwtPayload = {
  influencerId: string;
  role: "influencer";
  email?: string;
};

export function influencerAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;

    if (!header || !header.startsWith("Bearer ")) {
      throw new ApiError({
        status: HttpStatus.UNAUTHORIZED,
        code: ErrorCodes.AUTH_INVALID_TOKEN,
        message: "Authorization token missing",
      });
    }

    const token = header.split(" ")[1];

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new InternalError("JWT_SECRET is missing in env");
    }

    const decoded = jwt.verify(token, secret) as InfluencerJwtPayload;

    if (!decoded?.influencerId || decoded.role !== "influencer") {
      throw new ForbiddenError("Forbidden");
    }

    // attach user info to request
    (req as any).user = decoded;

    next();
  } catch (err) {
    // convert unknown jwt errors into ApiError style response
    if (err instanceof ApiError) return next(err);
    console.error("Error in influencerAuth middleware:", err);
    return next(
      new ApiError({
        status: HttpStatus.UNAUTHORIZED,
        code: ErrorCodes.AUTH_INVALID_TOKEN,
        message: "Invalid token",
        details: err,
      })
    );
  }
}
