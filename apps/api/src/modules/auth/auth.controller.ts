import type { Request, Response } from "express";
import { authService } from "./auth.service";

class AuthController {
  async login(req: Request, res: Response) {
    const result = await authService.login(req.body.email, req.body.password);
    res.json(result);
  }

  async refresh(req: Request, res: Response) {
    const result = await authService.refreshSession(req.body.refresh_token);
    res.json(result);
  }

  me(req: Request, res: Response) {
    res.json({ user: req.user });
  }
}

export const authController = new AuthController();
