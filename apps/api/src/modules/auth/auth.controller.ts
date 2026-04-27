import type { Request, Response } from "express";
import { authService } from "./auth.service";

class AuthController {
  login(req: Request, res: Response) {
    const result = authService.login(req.body.username, req.body.password);
    res.json(result);
  }

  me(req: Request, res: Response) {
    res.json({
      user: req.user
    });
  }
}

export const authController = new AuthController();
