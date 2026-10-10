package store

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/go-sql-driver/mysql"
)

func Open(ctx context.Context, dsn string) (*MySQL, error) {
	cfg, err := mysql.ParseDSN(dsn)
	if err != nil || cfg.DBName == "" {
		return nil, errors.New("MYSQL_DSN must specify a database")
	}
	if cfg.MultiStatements || cfg.AllowAllFiles || cfg.TLSConfig == "skip-verify" {
		return nil, errors.New("unsafe MYSQL_DSN options")
	}
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	cfg.Timeout = 5 * time.Second
	cfg.ReadTimeout = 5 * time.Second
	cfg.WriteTimeout = 5 * time.Second
	cfg.Collation = "utf8mb4_unicode_ci"
	if cfg.Params == nil {
		cfg.Params = map[string]string{}
	}
	cfg.Params["time_zone"] = "'+00:00'"
	connector, err := mysql.NewConnector(cfg)
	if err != nil {
		return nil, errors.New("invalid database configuration")
	}
	db := sql.OpenDB(connector)
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(3 * time.Minute)
	if err = db.PingContext(ctx); err != nil {
		db.Close()
		return nil, errors.New("database connection unavailable")
	}
	var changeSequence uint64
	if err = db.QueryRowContext(ctx, `SELECT sequence FROM sync_change_state WHERE id = 1`).Scan(&changeSequence); err != nil {
		db.Close()
		return nil, errors.New("incremental sync migration required")
	}
	s := New(db)
	meta, err := s.Meta(ctx)
	if err != nil || meta.SchemaVersion != 1 || len(meta.DatasetID) != 36 {
		db.Close()
		return nil, errors.New("database schema not initialized or unsupported")
	}
	return s, nil
}
func (s *MySQL) Close() error { return s.db.Close() }
