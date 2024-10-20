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


async function getPollFromDB(pollId) {
  const { data, error } = await supabase
    .from('polls')
    .select('*')
    .eq('id', pollId)
    .single();

  if (error) throw error;
  return data;
}

function calculateTotalVoteCost(vote){ return vote * vote};

function calculateNextVoteCost(currentVotes) {
  return Math.abs((Math.abs(currentVotes) + 1) ** 2 - Math.abs(currentVotes) ** 2);
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
          },
          {
            type: 'input',
            block_id: 'end_time_block',
            optional: true,
            element: {
              type: 'datetimepicker',
              action_id: 'end_time_input'
            },
            label: { type: 'plain_text', text: 'Poll End Time' }
          },
          {
            type: 'input',
            block_id: 'hide_votes_block',
            optional: true,
            element: {
              type: 'checkboxes',
              action_id: 'hide_votes_input',
              options: [
                {
                  text: { type: 'plain_text', text: 'Hide votes until poll is over' },
                  value: 'hide_votes'
                }
              ]
            },
            label: { type: 'plain_text', text: 'Vote Visibility' }
          }
        ],
        private_metadata: JSON.stringify({ channel_id: body.channel_id, user_id: body.user_id })
      }
    });
  } catch (error) {
    console.error('Error opening modal:', error);
  }
});

async function createPollInDB(topic, options, channelId, endTime, hideVotes, creatorId) {
  const ticketMultiplier = process.env.TICKET_MULTIPLIER || 5;
  const flexibilityFactor = process.env.FLEXIBILITY_FACTOR || 1;
  const startingTickets = Math.round(ticketMultiplier * Math.sqrt(options.length) * flexibilityFactor);

  const { data, error } = await supabase
    .from('polls')
    .insert({
      topic,
      options,
      votes: options.map(() => ({})),
      channel_id: channelId,
      starting_tickets: startingTickets,
      user_tokens: {},
      end_time: endTime ? new Date(endTime) : null,
      hide_votes: hideVotes,
      creator_id: creatorId
    })
    .select();

  if (error) throw error;
  return data[0];
}

async function updatePollInDB(pollId, votes, userTokens) {
  const { error } = await supabase
    .from('polls')
    .update({ votes, user_tokens: userTokens })
    .eq('id', pollId);

  if (error) throw error;
}

// Update the view submission handler
app.view('create_poll_modal', async ({ ack, body, view, client }) => {
  await ack();

  const { channel_id, user_id } = JSON.parse(view.private_metadata);
  const topic = view.state.values.topic_block.topic_input.value;
  const options = view.state.values.options_block.options_input.value.split('\n').filter(option => option.trim() !== '');
  
  const endTimeBlock = view.state.values.end_time_block;
  const endTime = endTimeBlock && endTimeBlock.end_time_input && endTimeBlock.end_time_input.selected_date_time ? endTimeBlock.end_time_input.selected_date_time * 1000 : null;
    
  const hideVotesBlock = view.state.values.hide_votes_block;
  const hideVotes = hideVotesBlock && hideVotesBlock.hide_votes_input.selected_options.length > 0;

  try {
    const pollData = await createPollInDB(topic, options, channel_id, endTime, hideVotes, user_id);
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
    const creatorId = body.message.metadata.event_payload.creator_id;
    const userId = body.user.id;
    let pollData = await getPollFromDB(pollId);

    const now = new Date();
    if (pollData.end_time && now >= new Date(pollData.end_time)) {
      await updatePollMessage(client, pollData);
      await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: 'Voting Ended' },
          close: { type: 'plain_text', text: 'Close' },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: 'This poll has already ended. You can no longer vote.'
              }
            }
          ]
        }
      });
    } else {
      const result = await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: 'modal',
          callback_id: 'vote_modal',
          title: { type: 'plain_text', text: 'Cast Your Votes' },
          close: { type: 'plain_text', text: 'Close' },
          blocks: [] // We'll fill this in openVoteModal
        }
      });
      pollData.view_id = result.view.id; // Store the view_id
      await openVoteModal(client, body.trigger_id, pollData, userId, creatorId);
    }
  } catch (error) {
    console.error('Error opening vote modal:', error);
  }
});

async function openVoteModal(client, triggerId, pollData, userId, creatorId) {
  const userVotes = getUserVotes(pollData, userId);
  const userTokens = pollData.user_tokens[userId] ?? pollData.starting_tickets;


  let modalBlocks = [
    {
      "type": "header",
      "text": {
        "type": "plain_text",
        "text": `Topic: ${pollData.topic}`,
        "emoji": true
      }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `_You have :admission_tickets: ${userTokens} tickets to spend._`
      }
    }
  ];

  pollData.options.forEach((option, index) => {
    const currentVotes = userVotes[index];
    const voteCost = calculateNextVoteCost(currentVotes);
    const totalVotes = Object.values(pollData.votes[index]).reduce((a, b) => a + b, 0);

    modalBlocks = modalBlocks.concat([
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `> * ${option}*\n ${currentVotes ? `:ballot_box_with_ballot: ${currentVotes} vote${Math.abs(currentVotes) > 1 ? 's' : ''}` : ''}`
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: `:heavy_plus_sign: Upvote`, emoji: true },
            value: `${pollData.id}|${index}|add`,
            action_id: `cast_vote_${index}_add`
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: `:heavy_minus_sign: Downvote`, emoji: true },
            value: `${pollData.id}|${index}|subtract`,
            action_id: `cast_vote_${index}_subtract`
          }
        ]
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Next vote costs ${voteCost} :admission_tickets:`
          }
        ]
      },
      {type: 'divider'}
    ]);
  });

  if (userId === creatorId) {
    modalBlocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'End Voting', emoji: true },
          style: 'danger',
          value: `${pollData.id}`,
          action_id: 'end_voting'
        }
      ]
    });
  }

  try {
    await client.views.update({
      view_id: pollData.view_id, // We need to store this when opening the modal
      view: {
        type: 'modal',
        callback_id: 'vote_modal',
        title: { type: 'plain_text', text: 'Cast Your Votes' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: modalBlocks
      }
    });
  } catch (error) {
    console.error('Error updating vote modal:', error);
    // If updating fails, open a new modal
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
}

app.action(/^cast_vote_\d+_(add|subtract)$/, async ({ ack, body, client, action }) => {
  await ack();

  try {
    const [pollId, optionIndex, voteType] = action.value.split('|');
    const userId = body.user.id;
    const pollData = await getPollFromDB(pollId);
    
    if (!pollData.user_tokens[userId]) {
      pollData.user_tokens[userId] = pollData.starting_tickets;
    }

    const currentVotes = pollData.votes[optionIndex][userId] || 0;
    const userTokensLeft = pollData.user_tokens[userId];
    
    let newVotes = currentVotes;
    if (voteType === 'add') {
      newVotes++;
    } else {
      newVotes--;
    }

    const currentCost = calculateTotalVoteCost(Math.abs(currentVotes));
    const newCost = calculateTotalVoteCost(Math.abs(newVotes));
    const voteCost = newCost - currentCost;

    if (voteCost > userTokensLeft) {
      // Notify the user about insufficient tokens
      await client.views.update({
        view_id: body.view.id,
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: 'Action Not Allowed' },
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
      return;
    }

    // Update votes and tokens
    pollData.votes[optionIndex][userId] = newVotes;
    pollData.user_tokens[userId] -= voteCost;

    await updatePollInDB(pollId, pollData.votes, pollData.user_tokens);
    await updatePollMessage(client, pollData);

    pollData.view_id = body.view.id; 
    await openVoteModal(client, body.trigger_id, pollData, userId, pollData.creator_id);
  } catch (error) {
    console.error('Error processing vote:', error);
  }
});

app.action('end_voting', async ({ ack, body, client }) => {
  await ack();

  try {
    const pollId = body.actions[0].value;
    const pollData = await getPollFromDB(pollId);

    if (body.user.id === pollData.creator_id) {
      await supabase
        .from('polls')
        .update({ end_time: new Date().toISOString() })
        .eq('id', pollId);

      pollData.end_time = new Date();
      await updatePollMessage(client, pollData);

      await client.views.update({
        view_id: body.view.id,
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: 'Voting Ended' },
          close: { type: 'plain_text', text: 'Close' },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: 'You have successfully ended the voting for this poll.'
              }
            }
          ]
        }
      });
    } else {
      console.error('Unauthorized attempt to end voting');
    }
  } catch (error) {
    console.error('Error ending voting:', error);
  }
});

function getPollMessagePayload(pollData) {
  const now = new Date();
  const endTime = pollData.end_time ? new Date(pollData.end_time) : null;
  const isEnded = endTime && now >= endTime;

  let blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${pollData.topic}*`
      }
    }
  ];

  if (isEnded) {
    const sortedOptions = pollData.options
      .map((option, index) => ({
        option,
        votes: Object.values(pollData.votes[index]).reduce((a, b) => a + b, 0)
      }))
      .sort((a, b) => b.votes - a.votes);

    blocks = blocks.concat(sortedOptions.map(({ option, votes }) => ({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${option}\n*:ballot_box_with_ballot: ${votes} votes*`
      }
    })));

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Poll ended <!date^${Math.floor(endTime.getTime() / 1000)}^{date} at {time}|${endTime.toLocaleString()}>`
        }
      ]
    });
  } else {
    blocks = blocks.concat(pollData.options.map((option, index) => {
      const optionVotes = Object.values(pollData.votes[index]).reduce((a, b) => a + b, 0);
      return {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: pollData.hide_votes
            ? `${option}`
            : `${option}\n*:ballot_box_with_ballot: ${optionVotes} votes*`
        }
      };
    }));

    blocks.push({
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
    });

    if (endTime) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Poll ends at <!date^${Math.floor(endTime.getTime() / 1000)}^{date} at {time}|${endTime.toLocaleString()}>`
          }
        ]
      });
    }
  }

  return {
    channel: pollData.channel_id,
    text: `Poll: ${pollData.topic}`,
    blocks: blocks,
    metadata: {
      event_type: "poll_update",
      event_payload: {
        poll_id: pollData.id,
        creator_id: pollData.creator_id
      }
    }
  };
}

async function postPollMessage(client, pollData) {
  const result = await client.chat.postMessage(getPollMessagePayload(pollData));
  await updatePollMessageTs(pollData.id, result.ts);
}

async function updatePollMessage(client, pollData) {
  const now = new Date();
  const endTime = pollData.end_time ? new Date(pollData.end_time) : null;
  const isEnded = endTime && now >= endTime;

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
