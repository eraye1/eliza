import { Client } from 'twitter-api-sdk';
import { EventEmitter } from 'events';
import { IAgentRuntime, Memory, State } from '../../core/types.ts';
import { embeddingZeroVector } from '../../core/memory.ts';
import { stringToUuid } from '../../core/uuid.ts';
import { composeContext } from '../../core/context.ts';

interface TwitterOAuthConfig {
  accessToken: string;
  refreshToken: string;
  username: string;
}

const tweetPrompt = `About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{postDirections}}

# Task: Generate a post in the voice and style of {{agentName}}, aka @{{twitterUserName}}
Write a single sentence post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Try to write something totally different than previous posts. Do not add commentary or acknowledge this request, just write the post.
Your response should not contain any questions. Brief, concise statements only. No emojis.`;

export class TwitterOAuthClient extends EventEmitter {
  private twitterClient: Client;
  private runtime: IAgentRuntime;
  private refreshTokenInterval: NodeJS.Timeout | null = null;
  private tweetInterval: NodeJS.Timeout | null = null;
  private lastTweetCheck: Date | null = null;
  private config: TwitterOAuthConfig;

  constructor({ runtime, config }: { runtime: IAgentRuntime; config: TwitterOAuthConfig }) {
    super();
    
    try {
      console.log('🔄 Starting Twitter OAuth client initialization...');
      
      // Validate config
      if (!config.accessToken) throw new Error('Missing access token');
      if (!config.refreshToken) throw new Error('Missing refresh token');
      if (!config.username) throw new Error('Missing username');
      
      this.runtime = runtime;
      this.config = config;
      
      console.log('Config validation passed:', {
        username: this.config.username,
        accessTokenLength: this.config.accessToken.length,
        refreshTokenLength: this.config.refreshToken.length
      });
      
      // Initialize Twitter client with OAuth2 token
      console.log('Initializing Twitter client...');
      this.twitterClient = new Client(this.config.accessToken);
      console.log('✅ Twitter client initialized successfully');
      
      console.log('🔄 Setting up token refresh...');
      this.setupTokenRefresh();
      
      console.log('🔄 Setting up hourly tweets...');
      this.setupHourlyTweets();

      console.log('🔄 Starting monitoring...');
      this.startMonitoring();
      
      console.log('✅ Twitter OAuth client setup complete');
    } catch (error) {
      console.error('❌ Failed to initialize Twitter client:', error);
      console.error('Stack trace:', error.stack);
    }
  }

  private async setupHourlyTweets() {
    if (this.tweetInterval) {
      clearInterval(this.tweetInterval);
    }

    await this.postHourlyTweet();

    this.tweetInterval = setInterval(async () => {
      try {
        await this.postHourlyTweet();
      } catch (error) {
        console.error('Failed to post hourly tweet:', error);
      }
    }, 60 * 60 * 1000);
  }

  private async postHourlyTweet() {
    try {
      const currentHour = new Date().getHours();
      if (true/*currentHour >= 8 && currentHour <= 23*/) {
        console.log(`🐦 Generating tweet as ${this.config.username}`);
        
        // Create a consistent room ID for tweets
        const twitterRoomId = stringToUuid('twitter_room');
        
        // Ensure room and user exist before proceeding
        await this.runtime.ensureRoomExists(twitterRoomId);
        await this.runtime.ensureUserExists(
          this.runtime.agentId,
          this.config.username,
          this.runtime.character.name,
          'twitter_oauth'
        );
        await this.runtime.ensureParticipantExists(
          this.runtime.agentId,
          twitterRoomId
        );

        // Generate random topic and adjective
        const topics = [
          'life', 'love', 'dreams', 'success', 'happiness', 
          'friendship', 'adventure', 'creativity', 'inspiration',
          'growth', 'change', 'passion', 'wisdom', 'courage'
        ];
        const adjectives = [
          'thoughtful', 'witty', 'sarcastic', 'inspiring', 'reflective',
          'humorous', 'passionate', 'observant', 'clever', 'insightful'
        ];

        const topic = topics[Math.floor(Math.random() * topics.length)];
        const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
        
        const state = await this.runtime.composeState(
          {
            userId: this.runtime.agentId,
            roomId: twitterRoomId,
            content: { text: '', action: '' },
          },
          {
            twitterUserName: this.config.username,
            topic,
            adjective
          }
        );

        // Generate tweet using the runtime's completion
        const context = composeContext({
          state,
          template: tweetPrompt,
        });

        console.log('Generating tweet with context:', {
          topic,
          adjective,
          username: this.config.username
        });

        const tweetContent = await this.runtime.completion({
          context,
          stop: ["<|eot_id|>", "<|eom_id|>"],
          temperature: 0.7,
          frequency_penalty: 1.2,
          model: this.runtime.character.settings?.model || "gpt-4-turbo",
        });

        if (tweetContent) {
          // Clean up the generated text
          let tweetText = tweetContent
            .replaceAll(/\\n/g, "\n")
            .replace(/^["']|["']$/g, '') // Remove quotes
            .replace(/^Tweet: /i, '')     // Remove "Tweet:" prefix
            .trim();

          // Ensure tweet is within Twitter's length limit
          if (tweetText.length > 280) {
            tweetText = tweetText.substring(0, 277) + '...';
          }

          console.log(`📝 Generated tweet: ${tweetText}`);
          await this.tweet(tweetText);
          console.log('✅ Tweet posted successfully');

          // Save the tweet as a memory
          const memory: Memory = {
            id: stringToUuid(Date.now().toString()),
            userId: this.runtime.agentId,
            roomId: twitterRoomId,
            content: {
              text: tweetText,
              source: 'twitter_oauth'
            },
            embedding: embeddingZeroVector,
            createdAt: Date.now()
          };

          await this.runtime.messageManager.createMemory(memory);
        }
      } else {
        console.log('Outside of tweeting hours, skipping tweet');
      }
    } catch (error) {
      console.error('Error posting hourly tweet:', error);
    }
  }

  private async refreshToken() {
    try {
      const response = await fetch('https://api.twitter.com/2/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${Buffer.from(`${process.env.TWITTER_CLIENT_ID}:${process.env.TWITTER_CLIENT_SECRET}`).toString('base64')}`,
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.config.refreshToken,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to refresh token');
      }

      const data = await response.json();
      
      // Update the client with new token
      this.twitterClient = new Client(data.access_token);
      
      // Update the config
      this.config.accessToken = data.access_token;
      if (data.refresh_token) {
        this.config.refreshToken = data.refresh_token;
      }

    } catch (error) {
      console.error('Error refreshing Twitter token:', error);
      throw error;
    }
  }

  private async setupTokenRefresh() {
    // Clear any existing interval
    if (this.refreshTokenInterval) {
      clearInterval(this.refreshTokenInterval);
    }

    // Refresh token every hour
    this.refreshTokenInterval = setInterval(async () => {
      try {
        await this.refreshToken();
      } catch (error) {
        console.error('Failed to refresh Twitter token:', error);
      }
    }, 60 * 60 * 1000); // 1 hour
  }

  private async startMonitoring() {
    // Check for new mentions every 1 hour
    /*setInterval(async () => {
      try {
        await this.checkNewMentions();
      } catch (error) {
        console.error('Error checking Twitter mentions:', error);
      }
    }, 60 * 60 * 1000);*/
  }

  async tweet(text: string): Promise<void> {
    try {
      await this.twitterClient.tweets.createTweet({
        text: text
      });
    } catch (error) {
      console.error('Error posting tweet:', error);
      throw error;
    }
  }

  async reply(text: string, inReplyToTweetId: string): Promise<void> {
    try {
      await this.twitterClient.tweets.createTweet({
        text: text,
        reply: {
          in_reply_to_tweet_id: inReplyToTweetId
        }
      });
    } catch (error) {
      console.error('Error posting reply:', error);
      throw error;
    }
  }

  // Make sure to clean up intervals when shutting down
  async cleanup() {
    if (this.refreshTokenInterval) {
      clearInterval(this.refreshTokenInterval);
    }
    if (this.tweetInterval) {
      clearInterval(this.tweetInterval);
    }
  }
} 