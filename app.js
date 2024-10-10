const { App } = require('@slack/bolt');
const { createClient } = require('@supabase/supabase-js');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  port: process.env.PORT || 3000
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function createPollInDB(topic, options, channelId) {
  const { data, error } = await supabase
    .from('polls')
    .insert({
      topic,
      options,
      votes: options.map(() => ({})),
      channel_id: channelId,
      total_tokens: 100 * options.length,
      user_tokens: {}
    })
    .select();

  if (error) throw error;
  return data[0];
}

async function updatePollInDB(pollId, votes, totalTokens, userTokens) {
  const { error } = await supabase
    .from('polls')
    .update({ votes, total_tokens: totalTokens, user_tokens: userTokens })
    .eq('id', pollId);

  if (error) throw error;
}

async function getPollFromDB(pollId) {
  const { data, error } = await supabase
    .from('polls')
    .select('*')
    .eq('id', pollId)
    .single();

  if (error) throw error;
  return data;
}

function calculateVoteCost(currentVotes) {
  return (currentVotes + 1) ** 2 - currentVotes ** 2;
}

function getUserVotes(pollData, userId) {
  return pollData.options.map((_, index) => pollData.votes[index][userId] || 0);
}

app.command('/create_poll', async ({ ack, body, client }) => {
  await ack();

  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'create_poll_modal',
        title: { type: 'plain_text', text: 'Create a Poll' },
        submit: { type: 'plain_text', text: 'Submit' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: 'topic_block',
            element: {
              type: 'plain_text_input',
              action_id: 'topic_input',
              placeholder: { type: 'plain_text', text: 'Enter your poll topic' }
            },
            label: { type: 'plain_text', text: 'Poll Topic' }
          },
          {
            type: 'input',
            block_id: 'options_block',
            element: {
              type: 'plain_text_input',
              action_id: 'options_input',
              multiline: true,
              placeholder: { type: 'plain_text', text: 'Enter options, one per line' }
            },
            label: { type: 'plain_text', text: 'Poll Options' }
          }
        ],
        private_metadata: JSON.stringify({ channel_id: body.channel_id })
      }
    });
  } catch (error) {
    console.error('Error opening modal:', error);
  }
});

app.view('create_poll_modal', async ({ ack, body, view, client }) => {
  await ack();

  const { channel_id } = JSON.parse(view.private_metadata);
  const topic = view.state.values.topic_block.topic_input.value;
  const options = view.state.values.options_block.options_input.value.split('\n').filter(option => option.trim() !== '');

  try {
    const pollData = await createPollInDB(topic, options, channel_id);
    await postPollMessage(client, pollData);
    console.log('Poll created successfully');
  } catch (error) {
    console.error('Error creating poll:', error);
  }
});

app.action('vote_button', async ({ ack, body, client }) => {
  await ack();

  try {
    const pollId = body.message.metadata.event_payload.poll_id;
    const userId = body.user.id;
    const pollData = await getPollFromDB(pollId);

    await openVoteModal(client, body.trigger_id, pollData, userId);
  } catch (error) {
    console.error('Error opening vote modal:', error);
  }
});

async function openVoteModal(client, triggerId, pollData, userId) {
  const userVotes = getUserVotes(pollData, userId);
  const userTokens = pollData.user_tokens[userId] || 100;

  const modalBlocks = [
    {
			"type": "header",
			"text": {
				"type": "plain_text",
				"text": `${pollData.topic}`,
				"emoji": true
			}
		},
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `_You have :admission_tickets: ${userTokens} tickets remaining._`
      }
    },
    ...pollData.options.map((option, index) => {
      const currentVotes = userVotes[index];
      const voteCost = calculateVoteCost(currentVotes);
      const totalVotes = Object.values(pollData.votes[index]).reduce((a, b) => a + b, 0);
      return {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*:ballot_box_with_ballot: ${totalVotes} votes:* ${option}`
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: `Vote (${voteCost} :admission_tickets:)`, emoji: true },
          value: `${pollData.id}|${index}`,
          action_id: `cast_vote_${index}`
        }
      };
    })
  ];

  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: 'vote_modal',
      title: { type: 'plain_text', text: 'Cast Your Votes' },
      close: { type: 'plain_text', text: 'Close' },
      blocks: modalBlocks
    }
  });
}

app.action(/^cast_vote_\d+$/, async ({ ack, body, client, action }) => {
  await ack();

  try {
    const [pollId, optionIndex] = action.value.split('|');
    const userId = body.user.id;
    const pollData = await getPollFromDB(pollId);
    
    const userVotes = getUserVotes(pollData, userId);
    const currentVotes = userVotes[optionIndex];
    const voteCost = calculateVoteCost(currentVotes);
    
    if (!pollData.user_tokens[userId]) {
      pollData.user_tokens[userId] = 100;
    }

    const userTokensLeft = pollData.user_tokens[userId];

    if (userTokensLeft >= voteCost) {
      if (!pollData.votes[optionIndex][userId]) {
        pollData.votes[optionIndex][userId] = 0;
      }
      pollData.votes[optionIndex][userId]++;
      pollData.user_tokens[userId] -= voteCost;
      pollData.total_tokens -= voteCost;

      await updatePollInDB(pollId, pollData.votes, pollData.total_tokens, pollData.user_tokens);
      await updatePollMessage(client, pollData);

      // Update the vote modal
      const updatedModalBlocks = [
        {
			"type": "header",
			"text": {
				"type": "plain_text",
				"text": `${pollData.topic}`,
				"emoji": true
			}
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `_You have :admission_tickets: ${pollData.user_tokens[userId]} tickets remaining._`
        }
      },
        ...pollData.options.map((option, index) => {
          const updatedUserVotes = getUserVotes(pollData, userId);
          const updatedCurrentVotes = updatedUserVotes[index];
          const updatedVoteCost = calculateVoteCost(updatedCurrentVotes);
          const totalVotes = Object.values(pollData.votes[index]).reduce((a, b) => a + b, 0);
          return {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*:ballot_box_with_ballot: ${totalVotes} votes: * ${option}`
            },
            accessory: {
              type: 'button',
              text: { type: 'plain_text', text: `Vote (${updatedVoteCost} :admission_tickets:)`, emoji: true },
              value: `${pollId}|${index}`,
              action_id: `cast_vote_${index}`
            }
          };
        })
      ];

      await client.views.update({
        view_id: body.view.id,
        view: {
          type: 'modal',
          callback_id: 'vote_modal',
          title: { type: 'plain_text', text: 'Cast Your Votes' },
          close: { type: 'plain_text', text: 'Close' },
          blocks: updatedModalBlocks
        }
      });
    } else {
      // Notify the user about insufficient tokens
      await client.views.update({
        view_id: body.view.id,
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: 'Insufficient Tokens' },
          close: { type: 'plain_text', text: 'Close' },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `You don't have enough tokens for this vote. You have ${userTokensLeft} tokens left, but this vote costs ${voteCost} tokens.`
              }
            }
          ]
        }
      });
    }
  } catch (error) {
    console.error('Error processing vote:', error);
  }
});

function getPollMessagePayload(pollData) {
  return {
    channel: pollData.channel_id,
    text: `Poll: ${pollData.topic}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${pollData.topic}*`
        }
      },
      ...pollData.options.map((option, index) => {
        const optionVotes = Object.values(pollData.votes[index]).reduce((a, b) => a + b, 0);
        return {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*:ballot_box_with_ballot: ${optionVotes} votes:* ${option}`
          }
        };
      }),
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Vote',
              emoji: true
            },
            value: 'vote',
            action_id: 'vote_button'
          }
        ]
      }
    ],
    metadata: {
      event_type: "poll_update",
      event_payload: {
        poll_id: pollData.id
      }
    }
  };
}

async function postPollMessage(client, pollData) {
  const result = await client.chat.postMessage(getPollMessagePayload(pollData));
  await updatePollMessageTs(pollData.id, result.ts);
}

async function updatePollMessage(client, pollData) {
  try {
    await client.chat.update({
      ...getPollMessagePayload(pollData),
      ts: pollData.message_ts
    });
  } catch (error) {
    console.error('Failed to update poll message:', error);
    await postPollMessage(client, pollData);
  }
}

async function updatePollMessageTs(pollId, messageTs) {
  const { error } = await supabase
    .from('polls')
    .update({ message_ts: messageTs })
    .eq('id', pollId);

  if (error) throw error;
}

(async () => {
  await app.start();
  console.log('⚡️ Bolt app is running!');
})();
