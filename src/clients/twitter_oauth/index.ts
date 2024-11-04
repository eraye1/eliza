import { TwitterOAuthClient } from './base.ts';
import { handleMention } from './interactions.ts';
import { IAgentRuntime, Memory, State } from '../../core/types.ts';

export default class TwitterOAuthIntegration extends TwitterOAuthClient {
  constructor(
    { runtime }: { runtime: IAgentRuntime }, 
    config: {
      accessToken: string;
      refreshToken: string;
      username: string;
    }
  ) {
    super({ runtime, config });

    // Set up event handlers
    this.on('mention', async (memory: Memory, state: State) => {
      await handleMention(this, memory, state);
    });
  }

  async onReady() {
    console.log('Twitter OAuth client ready');
  }
} 