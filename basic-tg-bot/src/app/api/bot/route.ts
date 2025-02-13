export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

import { Bot, webhookCallback } from "grammy";

import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage } from "@langchain/core/messages";
import {
  Aptos,
  AptosConfig,
  Ed25519PrivateKey,
  Network,
  PrivateKey,
  PrivateKeyVariants,
} from "@aptos-labs/ts-sdk";

import { AgentRuntime, LocalSigner, createAptosTools } from "move-agent-kit";
import { ChatAnthropic } from "@langchain/anthropic";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN environment variable not found.");
}
const bot = new Bot(token);

async function initializeAgent(userId: string) {
  try {
    const llm = new ChatAnthropic({
      modelName: "claude-3-5-sonnet-20241022",
      temperature: 0.7,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    });
    const aptosConfig = new AptosConfig({
      network: Network.MAINNET,
    });

    const aptos = new Aptos(aptosConfig);

    // Validate and get private key from environment
    const privateKeyStr = process.env.APTOS_PRIVATE_KEY;
    if (!privateKeyStr) {
      throw new Error("Missing APTOS_PRIVATE_KEY environment variable");
    }

    // Setup account and signer
    const account = await aptos.deriveAccountFromPrivateKey({
      privateKey: new Ed25519PrivateKey(
        PrivateKey.formatPrivateKey(privateKeyStr, PrivateKeyVariants.Ed25519)
      ),
    });

    const signer = new LocalSigner(account, Network.MAINNET);
    const aptosAgent = new AgentRuntime(signer, aptos, {
      PANORA_API_KEY: process.env.PANORA_API_KEY,
    });
    const tools = createAptosTools(aptosAgent);
    const memory = new MemorySaver();
    const config = { configurable: { thread_id: userId } };
    const agent = createReactAgent({
      llm,
      tools,
      checkpointSaver: memory,
      messageModifier: `
      You are a helpful agent that can interact onchain using the Move Agent Kit. 
      You are empowered to interact onchain using your tools. 
      If you ever need funds, you can request them from the testnet faucet. 
      If not, you can provide your wallet details and request funds from the user. If there is a 5XX (internal) HTTP error code, ask the user to try again later. If someone asks you to do something you can't do with your currently available tools, you must say so, and encourage them to implement it themselves using the Move Agent Kit, recommend they go to the Aptos documentation for more information about Move development. Be concise and helpful with your responses. Refrain from restating your tools' descriptions unless it is explicitly requested.
      `,
    });
    return { agent, config };
  } catch (error) {
    console.error("Failed to initialize agent:", error);
    throw error;
  }
}
// Telegram bot handler
bot.on("message:text", async (ctx: any) => {
  const userId = ctx.from?.id.toString();
  if (!userId) {
    return;
  }
  const { agent, config } = await initializeAgent(userId);
  const stream = await agent.stream(
    { messages: [new HumanMessage(ctx.message.text)] },
    config
  );
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Timeout")), 20000)
  );
  try {
    for await (const chunk of (await Promise.race([
      stream,
      timeoutPromise,
    ])) as AsyncIterable<{ agent?: any; tools?: any }>) {
      if ("agent" in chunk) {
        if (chunk.agent.messages[0].content) {
          const messageContent = chunk.agent.messages[0].content;

          if (Array.isArray(messageContent)) {
            const extractedTexts = messageContent
              .filter((msg) => msg.type === "text")
              .map((msg) => msg.text)
              .join("\n\n");

            await ctx.reply(extractedTexts || "No text response available.");
          } else if (typeof messageContent === "object") {
            await ctx.reply(JSON.stringify(messageContent, null, 2));
          } else {
            await ctx.reply(String(messageContent));
          }
        }
      }
    }
  } catch (error: any) {
    if (error.message === "Timeout") {
      await ctx.reply(
        "I'm sorry, the operation took too long and timed out. Please try again."
      );
    } else {
      console.error("Error processing stream:", error);
      await ctx.reply(
        "I'm sorry, an error occurred while processing your request."
      );
    }
  }
});

export const POST = async (req: Request) => {
  const headers = new Headers();
  headers.set("x-vercel-background", "true");

  const handler = webhookCallback(bot, "std/http");

  return handler(req);
};

/* For testing purposes */

export const GET = async (req: Request) => {
  try {
    bot.start();
    console.log("Bot is running in polling mode...");
  } catch (error) {
    console.log("Error starting bot:", error);
    return new Response("Error starting bot", { status: 500 });
  }

  return new Response("Bot is running in polling mode...", {
    status: 200,
  });
};
