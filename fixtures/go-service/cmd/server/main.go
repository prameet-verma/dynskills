package main

import (
	"log"
	"net/http"

	"github.com/example/go-service/internal/handler"
	"github.com/go-chi/chi/v5"
)

func main() {
	r := chi.NewRouter()
	r.Get("/health", handler.Health)
	log.Fatal(http.ListenAndServe(":8080", r))
}
