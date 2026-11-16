from fastapi import FastAPI

from app.routers import orders

app = FastAPI(title="Orders API")
app.include_router(orders.router, prefix="/orders")
