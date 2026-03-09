import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { ApiResponse } from "../core/http/ApiResponse";
import { HttpStatus } from "../core/http/HttpStatus";
import { AdminModel } from "../model/admin";

/** ✅ your new access structure (stored on Admin) */
export type AdminAccessItem = {
  key: string;        // module key, e.g. "policy"
  name?: string;      // optional label
  isEdit: boolean;
  isDelete: boolean;
};

export type AdminJwtPayload = {
  adminId: string;
  role?: string; // token role is NOT trusted
  email?: string;
  iat?: number;
  exp?: number;
};

/** what we attach on req after DB validation */
export type ReqAdmin = {
  adminId: string;
  email?: string;
  role: string;                 // from DB
  access: AdminAccessItem[];    // from DB (Admin.access)
  iat?: number;
  exp?: number;
};

function getRequestId(req: Request) {
  return (
    (req as any).requestId ||
    (req as any).id ||
    (req.headers["x-request-id"] as string) ||
    "NA"
  );
}

const normalizeKey = (v: any) =>
  String(v ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");

/**
 * ✅ AUTH + ACCESS LOADER (NEW STRUCTURE)
 * - verifies JWT
 * - fetches Admin from DB
 * - uses Admin.role + Admin.access (no RoleModel)
 * - attaches req.admin = { adminId, role, access, email }
 */
export async function adminAuth(req: Request, res: Response, next: NextFunction) {
  const requestId = getRequestId(req);

  try {
    const header = req.headers.authorization;

    if (!header || !header.startsWith("Bearer ")) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.UNAUTHORIZED,
        "UNAUTHORIZED" as any,
        "Authorization token missing",
        requestId
      );
    }

    const token = header.split(" ")[1];
    const secret = process.env.JWT_SECRET;

    if (!secret) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.INTERNAL_SERVER_ERROR,
        "INTERNAL_ERROR" as any,
        "JWT_SECRET is missing in env",
        requestId
      );
    }

    const decoded = jwt.verify(token, secret) as AdminJwtPayload;

    if (!decoded?.adminId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.UNAUTHORIZED,
        "UNAUTHORIZED" as any,
        "Invalid token",
        requestId
      );
    }

    // ✅ load admin from DB (single source of truth)
    const admin = await AdminModel.findById(decoded.adminId).select(
      "email role status access"
    );

    if (!admin) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.UNAUTHORIZED,
        "UNAUTHORIZED" as any,
        "Admin not found",
        requestId
      );
    }

    const adminStatus = normalizeKey((admin as any).status || "");
    if (adminStatus && adminStatus !== "active") {
      return ApiResponse.sendFail(
        res,
        HttpStatus.FORBIDDEN,
        "FORBIDDEN" as any,
        "Admin account is not active",
        requestId
      );
    }

    const roleKey = String((admin as any).role || "").trim();
    if (!roleKey) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.FORBIDDEN,
        "FORBIDDEN" as any,
        "Role not assigned",
        requestId
      );
    }

    const accessRaw = (admin as any).access;
    const access: AdminAccessItem[] = Array.isArray(accessRaw)
      ? accessRaw.map((a: any) => ({
          key: normalizeKey(a?.key),
          name: a?.name ? String(a.name) : undefined,
          isEdit: Boolean(a?.isEdit),
          isDelete: Boolean(a?.isDelete),
        }))
      : [];

    const reqAdmin: ReqAdmin = {
      adminId: String((admin as any)._id),
      email: (admin as any).email || decoded.email,
      role: roleKey,
      access,
      iat: decoded.iat,
      exp: decoded.exp,
    };

    (req as any).admin = reqAdmin;
    return next();
  } catch (err: any) {
    return ApiResponse.sendFail(
      res,
      HttpStatus.UNAUTHORIZED,
      "UNAUTHORIZED" as any,
      "Invalid token",
      requestId
    );
  }
}

/**
 * ✅ Guard: checks module access exists in admin.access[]
 * usage:
 * router.get("/policies", adminAuth, requireAccess("policy"), listPolicies)
 */
export function requireAccess(required: string | string[]) {
  const requiredList = Array.isArray(required) ? required : [required];
  const requiredKeys = requiredList.map(normalizeKey);

  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = getRequestId(req);

    const admin = (req as any)?.admin as ReqAdmin | undefined;
    if (!admin?.adminId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.UNAUTHORIZED,
        "UNAUTHORIZED" as any,
        "Unauthorized",
        requestId
      );
    }

    const accessKeys = new Set((admin.access || []).map((a) => normalizeKey(a.key)));
    const ok = requiredKeys.every((k) => accessKeys.has(k));

    if (!ok) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.FORBIDDEN,
        "FORBIDDEN" as any,
        "You don't have access to this API",
        requestId
      );
    }

    return next();
  };
}

/**
 * ✅ Guard: checks isEdit=true for module(s)
 * usage:
 * router.put("/policy/:id", adminAuth, requireEditPermission("policy"), editPolicy)
 */
export function requireEditPermission(required: string | string[]) {
  const requiredList = Array.isArray(required) ? required : [required];
  const requiredKeys = requiredList.map(normalizeKey);

  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = getRequestId(req);

    const admin = (req as any)?.admin as ReqAdmin | undefined;
    if (!admin?.adminId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.UNAUTHORIZED,
        "UNAUTHORIZED" as any,
        "Unauthorized",
        requestId
      );
    }

    const map = new Map<string, AdminAccessItem>();
    (admin.access || []).forEach((a) => map.set(normalizeKey(a.key), a));

    const ok = requiredKeys.every((k) => Boolean(map.get(k)?.isEdit));
    if (!ok) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.FORBIDDEN,
        "FORBIDDEN" as any,
        "You don't have permission to edit",
        requestId
      );
    }

    return next();
  };
}

/**
 * ✅ Guard: checks isDelete=true for module(s)
 * usage:
 * router.delete("/policy/:id", adminAuth, requireDeletePermission("policy"), deletePolicy)
 */
export function requireDeletePermission(required: string | string[]) {
  const requiredList = Array.isArray(required) ? required : [required];
  const requiredKeys = requiredList.map(normalizeKey);

  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = getRequestId(req);

    const admin = (req as any)?.admin as ReqAdmin | undefined;
    if (!admin?.adminId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.UNAUTHORIZED,
        "UNAUTHORIZED" as any,
        "Unauthorized",
        requestId
      );
    }

    const map = new Map<string, AdminAccessItem>();
    (admin.access || []).forEach((a) => map.set(normalizeKey(a.key), a));

    const ok = requiredKeys.every((k) => Boolean(map.get(k)?.isDelete));
    if (!ok) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.FORBIDDEN,
        "FORBIDDEN" as any,
        "You don't have permission to delete",
        requestId
      );
    }

    return next();
  };
}

/**
 * ✅ keep strict role checks if needed (role comes from DB via adminAuth)
 * usage:
 * router.post("/admin/invite", adminAuth, requireAdminRoles(["superadmin"]), inviteAdmin)
 */
export function requireAdminRoles(roles: string[]) {
  const allowed = roles.map((r) => String(r).trim());

  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = getRequestId(req);

    const role = String((req as any)?.admin?.role || "").trim();
    if (!role || !allowed.includes(role)) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.FORBIDDEN,
        "FORBIDDEN" as any,
        "You don't have access to this API",
        requestId
      );
    }

    return next();
  };
}
