import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import { ApiError } from "../../utils/api-error";

class AuthService {
  login(username: string, password: string) {
    if (username !== env.ADMIN_USERNAME || password !== env.ADMIN_PASSWORD) {
      throw new ApiError(401, "Invalid credentials");
    }

    const token = jwt.sign({ sub: username, role: "admin" }, env.JWT_SECRET, {
      expiresIn: "12h"
    });

    return {
      token,
      expiresIn: "12h"
    };
  }
}

export const authService = new AuthService();
