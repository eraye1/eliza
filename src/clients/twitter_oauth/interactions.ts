import { TwitterOAuthClient } from './base.ts';
import { Memory, State } from '../../core/types.ts';

export async function handleMention(
  client: TwitterOAuthClient,
  memory: Memory,
  state: State
): Promise<void> {
  try {
    // Generate response using the runtime
    /*const response = await state.runtime.generate(memory);
    
    if (response && response.content.text) {
      // If this is a reply to a tweet
      if (memory.content.inReplyTo) {
        await client.reply(response.content.text, memory.id.toString());
      } else {
        // Otherwise post as a new tweet
        await client.tweet(response.content.text);
      }

      // Save the response as a memory
      await state.runtime.messageManager.createMemory({
        ...response,
        embedding: memory.embedding,
      });
    }*/
  } catch (error) {
    console.error('Error handling Twitter mention:', error);
    throw error;
  }
} 