def test_missing_order_returns_404(client):
    assert client.get("/orders/1").status_code == 404
