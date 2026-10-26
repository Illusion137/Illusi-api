-- pgvector must exist before track_vectors_table's vector column and HNSW index.
CREATE EXTENSION IF NOT EXISTS vector;
