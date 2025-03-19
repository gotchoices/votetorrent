#!/usr/bin/env node
import { Command } from 'commander';
import { createLibp2pNode } from '@votetorrent/vote-engine';

const program = new Command();

program
  .name('vt-test')
  .description('VoteTorrent test CLI')
  .version('0.0.1');

program
  .command('start-node')
  .description('Start a P2P node')
  .option('-p, --port <number>', 'Port to listen on', '0')
	.option('-b, --bootstrap <string>', 'Comma-separated list of bootstrap nodes')
	.option('-i, --id <string>', 'Peer ID')
	.option('-r, --relay', 'Enable relay service')
	.option('-n, --network <string>', 'Network name')
  .action(async (options) => {
    const node = await createLibp2pNode({
			port: parseInt(options.port),
			bootstrapNodes: options.bootstrap == null ? [] : options.bootstrap.split(','),
			id: options.id,
			relay: options.relay,
			networkName: options.network
		});
    console.log(`Node started with ID: ${node.peerId.toString()}`);
    console.log(`Listening on:`);
    node.getMultiaddrs().forEach((ma) => {
      console.log(ma.toString());
    });
  });

program
  .command('create-diary')
  .description('Create a new diary collection')
  .requiredOption('-n, --name <string>', 'Name of the diary')
  .action(async (options) => {
    // TODO: Implement diary creation
    console.log(`Creating diary: ${options.name}`);
  });

program
  .command('add-entry')
  .description('Add an entry to a diary')
  .requiredOption('-d, --diary <string>', 'Name of the diary')
  .requiredOption('-c, --content <string>', 'Entry content')
  .action(async (options) => {
    // TODO: Implement entry addition
    console.log(`Adding entry to diary ${options.diary}: ${options.content}`);
  });

program.parse();
