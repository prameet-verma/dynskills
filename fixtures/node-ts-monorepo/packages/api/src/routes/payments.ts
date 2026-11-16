import { Router } from "express";
import { z } from "zod";

const CreatePayment = z.object({ amount: z.number().int().positive(), currency: z.string().length(3) });

export const paymentsRouter = Router();

paymentsRouter.post("/", (req, res) => {
  const parsed = CreatePayment.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  return res.status(201).json({ id: "pay_123", ...parsed.data });
});
