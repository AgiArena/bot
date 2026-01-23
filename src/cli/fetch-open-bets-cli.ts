#!/usr/bin/env bun
/**
 * CLI entry point for fetching open bets
 * Usage: bun run src/cli/fetch-open-bets-cli.ts <output_path> [api_base_url]
 */

// Retry configuration from environment variables
const MAX_RETRIES = parseInt(process.env.API_MAX_RETRIES || "3", 10);
const BASE_BACKOFF_MS = parseInt(process.env.API_BASE_BACKOFF_MS || "1000", 10);

interface Bet {
  betId: string;
  creatorAddress: string;
  portfolioSize: number;
  amount: string;
  matchedAmount: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface BetsResponse {
  bets: Bet[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

/**
 * Fetch all open bets with pagination
 */
async function fetchOpenBets(apiBaseUrl: string): Promise<Bet[]> {
  const allBets: Bet[] = [];
  let page = 1;
  let hasMore = true;
  const limit = 100;

  console.log("Fetching open bets from backend...");
  console.log("API URL:", apiBaseUrl);

  while (hasMore) {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Fetch bets with status filter
        const url = `${apiBaseUrl}/api/bets?page=${page}&limit=${limit}&status=open`;
        const response = await fetch(url, {
          headers: {
            "Accept": "application/json"
          }
        });

        if (!response.ok) {
          throw new Error(`API error: ${response.status} ${response.statusText}`);
        }

        const data: BetsResponse = await response.json();

        // Filter for open statuses (pending or partially_matched)
        const openBets = data.bets.filter(bet =>
          bet.status === "pending" || bet.status === "partially_matched"
        );

        allBets.push(...openBets);
        hasMore = data.pagination.hasMore;
        page++;
        lastError = null;

        console.log(`Fetched page ${page - 1}: ${openBets.length} open bets (total: ${allBets.length})`);
        break; // Success, exit retry loop

      } catch (error) {
        lastError = error as Error;
        console.error(`Attempt ${attempt} failed: ${(error as Error).message}`);

        if (attempt < MAX_RETRIES) {
          // Exponential backoff using configurable base
          const delay = Math.pow(2, attempt - 1) * BASE_BACKOFF_MS;
          console.log(`Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    if (lastError) {
      throw lastError;
    }
  }

  return allBets;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error("Usage: bun run fetch-open-bets-cli.ts <output_path> [api_base_url]");
    process.exit(1);
  }

  const outputPath = args[0];
  const apiBaseUrl = args[1] || process.env.API_BASE_URL || "http://localhost:3001";

  try {
    const openBets = await fetchOpenBets(apiBaseUrl);

    // Write to output file
    await Bun.write(outputPath, JSON.stringify({
      bets: openBets,
      metadata: {
        totalBets: openBets.length,
        fetchedAt: new Date().toISOString()
      }
    }, null, 2));

    console.log("");
    console.log("=== Open Bets Summary ===");
    console.log("Total open bets:", openBets.length);
    console.log("Written to:", outputPath);
    console.log("");

    // Group by status
    const pendingCount = openBets.filter(b => b.status === "pending").length;
    const partialCount = openBets.filter(b => b.status === "partially_matched").length;
    console.log("Pending:", pendingCount);
    console.log("Partially matched:", partialCount);
    console.log("");
    console.log("SUCCESS: Open bets fetched");

  } catch (error) {
    console.error("ERROR: Failed to fetch open bets");
    console.error((error as Error).message);

    // Write error state to file
    await Bun.write(outputPath, JSON.stringify({
      bets: [],
      metadata: {
        totalBets: 0,
        fetchedAt: new Date().toISOString(),
        error: (error as Error).message
      }
    }, null, 2));

    process.exit(1);
  }
}

main();
