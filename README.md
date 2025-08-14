# WhatsApp Expense Tracker

A TypeScript-based WhatsApp bot that processes expense messages and automatically updates Google Sheets using AI-powered text extraction.

## Features

- 🤖 AI-powered expense extraction using Groq
- 📊 Automatic Google Sheets integration
- 📱 WhatsApp Web integration
- 🔒 Number-based access control
- 📸 Image message support with captions
- 🔄 Automatic reconnection handling

## Setup

### Prerequisites

- [Bun](https://bun.sh) runtime
- Google Service Account with Sheets API access
- Groq API key
- WhatsApp account

### Installation

```bash
bun install
```

### Environment Configuration

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Required environment variables:
- `GROQ_API_KEY`: Your Groq API key
- `GOOGLE_SHEETS_ID`: Your Google Sheet ID
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`: Service account email
- `GOOGLE_PRIVATE_KEY`: Service account private key
- `ALLOWED_NUMBERS`: Comma-separated list of allowed phone numbers (optional)

## Usage

### Development

```bash
bun dev
```

### Production

```bash
bun start
```

### Type Checking

```bash
bun run type-check
```

### Build

```bash
bun run build
```

## Message Format

Send messages in natural language:
- "Coffee 5 dollars"
- "Groceries $25.50"
- "Lunch 12 usd"

The bot will extract the item, price, and currency automatically and add it to your Google Sheet.

## Project Structure

- `index.ts` - Main application entry point
- `types.ts` - TypeScript type definitions
- `tsconfig.json` - TypeScript configuration
- `.env` - Environment variables (create from .env.example)

This project uses TypeScript with Bun runtime for optimal performance and type safety.
# wp-expenss
# wp-expenss
# wp-expenss
# wp-expenss
