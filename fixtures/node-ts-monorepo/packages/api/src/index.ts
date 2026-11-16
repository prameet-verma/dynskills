import express from "express";
import { paymentsRouter } from "./routes/payments.js";

const app = express();
app.use(express.json());
app.use("/payments", paymentsRouter);

app.listen(Number(process.env.PORT ?? 3000));
