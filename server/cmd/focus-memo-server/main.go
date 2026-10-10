package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"focus-memo/server/internal/attachments"
	"focus-memo/server/internal/config"
	"focus-memo/server/internal/httpapi"
	"focus-memo/server/internal/store"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Getenv); err != nil {
		log.Printf("startup or service failure: %v", err)
		os.Exit(1)
	}
}
func run(ctx context.Context, get func(string) string) error {
	cfg, err := config.Load(get)
	if err != nil {
		return err
	}
	dbCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	db, err := store.Open(dbCtx, cfg.DSN)
	cancel()
	if err != nil {
		return err
	}
	defer db.Close()
	files, err := attachments.New(cfg.AttachmentsDir, cfg.MaxUploadBytes, cfg.MaxImagePixels)
	if err != nil {
		return errors.New("attachment directory unavailable")
	}
	handler, err := httpapi.New(cfg, db, files)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		return errors.New("HTTP listen address unavailable")
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 70 * time.Second, WriteTimeout: 90 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	select {
	case err = <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return errors.New("HTTP server stopped unexpectedly")
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err = server.Shutdown(shutdown); err != nil {
			_ = server.Close()
			return errors.New("HTTP shutdown timed out")
		}
		return nil
	}
}
