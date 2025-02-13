export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

import { Bot, webhookCallback, Context, InlineKeyboard } from "grammy";
import { Tool } from "langchain/tools";

import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage } from "@langchain/core/messages";
import { getApps, initializeApp, getApp } from "firebase/app";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import {
  Account,
  Aptos,
  AptosConfig,
  Ed25519Account,
  Ed25519PrivateKey,
  Network,
  PrivateKey,
  PrivateKeyVariants,
} from "@aptos-labs/ts-sdk";

import { AgentRuntime, LocalSigner, createAptosTools } from "move-agent-kit";
import { ChatAnthropic } from "@langchain/anthropic";

const token = process.env.TELEGRAM_BOT_TOKEN;
console.log(token);
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN environment variable not found.");
}
const bot = new Bot(token);
const memorySaver = new MemorySaver();
const userImportState = new Map<string, boolean>();

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

const app = !getApps.length ? initializeApp(firebaseConfig) : getApp();
const db = getFirestore(app);

async function getOrCreateUserWallet(userId: string) {
  const userDocRef = doc(db, "users", userId);
  const userDocSnap = await getDoc(userDocRef);
  if (userDocSnap.exists()) {
    const AccountData = userDocSnap.data();
    const privateKey = new Ed25519PrivateKey(
      PrivateKey.formatPrivateKey(
        AccountData.privateKey,
        PrivateKeyVariants.Ed25519
      )
    );
    const AptosAccount = Account.fromPrivateKey({
      privateKey: privateKey,
    });
    return { AptosAccount, inProgress: AccountData.inProgress };
  }
  const AptosAccount = Account.generate();

  // you should encrypt the private key before storing it in the database
  const AccountData = {
    publicKey: AptosAccount.publicKey.toString(),
    privateKey: AptosAccount.privateKey.toString(),
    inProgress: false,
    inGame: false,
  };
  await setDoc(userDocRef, AccountData);
  return { AptosAccount, inProgress: false };
}

export class AptosPrivateKeyTool extends Tool {
  name = "aptos_get_private_key";
  description = "Get the wallet private key of the agent";

  constructor(private agent: AgentRuntime, private privateKey: string) {
    super();
  }

  async _call(_input: string): Promise<string> {
    return this.privateKey;
  }
}

async function initializeAgent(userId: string, AptosAccount: Ed25519Account) {
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

    const signer = new LocalSigner(AptosAccount, Network.MAINNET);
    const aptosAgent = new AgentRuntime(signer, aptos, {
      PANORA_API_KEY: process.env.PANORA_API_KEY,
    });
    const tools = createAptosTools(aptosAgent);
    const config = { configurable: { thread_id: userId } };
    const agent = createReactAgent({
      llm,
      tools: [
        ...tools,
        new AptosPrivateKeyTool(aptosAgent, AptosAccount.privateKey.toString()),
      ],
      checkpointSaver: memorySaver,
      messageModifier: `
      You are a helpful agent that can interact onchain using the Move Agent Kit. 
      You are empowered to interact onchain using your tools. 
      If not, you can provide your wallet details and request funds from the user. If there is a 5XX (internal) HTTP error code, ask the user to try again later. If someone asks you to do something you can't do with your currently available tools, you must say so, and encourage them to implement it themselves using the Move Agent Kit, recommend they go to the Aptos documentation for more information about Move development. Be concise and helpful with your responses. Refrain from restating your tools' descriptions unless it is explicitly requested.
      `,
    });
    return { agent, config };
  } catch (error) {
    console.error("Failed to initialize agent:", error);
    throw error;
  }
}

// Helper function to validate private key
function validatePrivateKey(privateKey: string): string | null {
  try {
    const cleanKey = privateKey.trim();

    if (!cleanKey.match(/^[0-9a-fA-F]{64}$/)) {
      return null;
    }
    return cleanKey;
  } catch (error) {
    return null;
  }
}

bot.command("start", async (ctx) => {
  console.log("command start");
  // add a condition to check if the user is already logged in
  const userId = ctx.from?.id.toString();
  if (!userId) {
    return;
  }
  const userDocRef = doc(db, "users", userId);
  const userDocSnap = await getDoc(userDocRef);
  if (!userDocSnap.exists()) {
    const keyboard = new InlineKeyboard()
      .text("Create New Account", "create_account")
      .text("Import Existing Account", "import_account");

    await ctx.reply(
      "Welcome! Would you like to create a new account or import an existing one?",
      { reply_markup: keyboard }
    );
  }
});

// Handle button callbacks
bot.callbackQuery("create_account", async (ctx) => {
  const userId = ctx.from.id.toString();
  const { AptosAccount } = await getOrCreateUserWallet(userId);
  await ctx.reply(
    "Your new account has been created! Here's your wallet address:"
  );
  await ctx.reply(`${String(AptosAccount.publicKey)}`);
  await ctx.reply(
    "You can now start using the bot. Send any message to begin!"
  );
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("import_account", async (ctx) => {
  const userId = ctx.from.id.toString();

  // Validate private key
  await ctx.reply(
    "Please send your private key in hex format (64 characters)."
  );

  userImportState.set(userId, true);

  await ctx.answerCallbackQuery();
});

// Telegram bot handler
bot.on("message:text", async (ctx: Context) => {
  console.log("here");
  const userId = ctx.from?.id.toString();
  console.log(userId);
  if (!userId) {
    return;
  }
  const userDocRef = doc(db, "users", userId);

  const privateKeyInput = ctx.message?.text || "";

  if (userImportState.get(userId)) {
    const validatedKey = validatePrivateKey(privateKeyInput);

    if (!validatedKey) {
      await ctx.reply(
        "Invalid private key format. Please try again with a valid 64-character hex private key."
      );
      return;
    }

    try {
      const privateKeyStr = validatedKey;
      const privateKey = new Ed25519PrivateKey(
        PrivateKey.formatPrivateKey(privateKeyStr, PrivateKeyVariants.Ed25519)
      );
      // Import wallet with private key
      const AptosAccount = Account.fromPrivateKey({
        privateKey: privateKey,
      });
      const AccountData = {
        publicKey: AptosAccount.publicKey.toString(),
        privateKey: AptosAccount.privateKey.toString(),
        inProgress: false,
        inGame: false,
      };
      await setDoc(userDocRef, AccountData);
      await ctx.reply("Account successfully imported! Your wallet address is:");
      await ctx.reply(`${AptosAccount.publicKey.toString()}`);

      await ctx.reply(
        "Your account is ready! You can now start using the bot."
      );

      // Remove user from the import state tracking
      userImportState.delete(userId);
    } catch (error) {
      console.error("Error importing account:", error);
      await ctx.reply(
        "Error importing account. Please check your private key and try again."
      );
    }
  }

  const { AptosAccount, inProgress } = await getOrCreateUserWallet(userId);
  if (inProgress) {
    await ctx.reply(`Hold on! I'm still processing...`);
    return;
  }

  const { agent, config } = await initializeAgent(userId, AptosAccount);

  const stream = await agent.stream(
    { messages: [new HumanMessage(ctx.message?.text || "")] },
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
