# SAM Billing Complaint Pipeline

## What this project is
A three-phase data pipeline to collect and analyze medical billing complaints 
for product requirements extraction. See requirements doc for full spec.

## Project structure
- Phase 1: CFPB API ingest → /phase1/
- Phase 2: Reddit scraping → /phase2/  
- Phase 3: Claude analysis layer → /phase3/
- Shared schema and DB utilities → /shared/

## Stack
Node.js 20+, TypeScript, better-sqlite3, @anthropic-ai/sdk

## Credentials
All API keys in .env (never commit)