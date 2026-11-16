from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


class Order(BaseModel):
    id: int
    sku: str
    quantity: int


_ORDERS: dict[int, Order] = {}


@router.get("/{order_id}")
def get_order(order_id: int) -> Order:
    if order_id not in _ORDERS:
        raise HTTPException(status_code=404, detail="order not found")
    return _ORDERS[order_id]
