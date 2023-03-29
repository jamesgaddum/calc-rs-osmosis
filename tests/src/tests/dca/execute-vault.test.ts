import { coin } from '@cosmjs/stargate';
import { expect } from 'chai';
import dayjs, { Dayjs } from 'dayjs';
import { Context } from 'mocha';
import { execute } from '../../shared/cosmwasm';
import { Vault } from '../../types/dca/response/get_vaults';
import { createVault, getBalances } from '../helpers';
import { setTimeout } from 'timers/promises';
import { EventData } from '../../types/dca/response/get_events';
import { find, map } from 'ramda';

describe('when executing a vault', () => {
  describe('with a ready time trigger', () => {
    let targetTime: Dayjs;
    let vaultBeforeExecution: Vault;
    let vaultAfterExecution: Vault;
    let balancesBeforeExecution: Record<string, number>;
    let balancesAfterExecution: Record<string, number>;
    let eventPayloadsBeforeExecution: EventData[];
    let eventPayloadsAfterExecution: EventData[];
    let executionTriggeredEvent: EventData;
    let receivedAmount: number;
    let receivedAmountAfterFee: number;

    before(async function (this: Context) {
      targetTime = dayjs().add(5, 'second');

      const vaultId = await createVault(this, {
        target_start_time_utc_seconds: `${targetTime.unix()}`,
      });

      vaultBeforeExecution = (
        await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
          get_vault: {
            vault_id: vaultId,
          },
        })
      ).vault;

      balancesBeforeExecution = await getBalances(this.cosmWasmClient, [
        this.userWalletAddress,
        this.dcaContractAddress,
        this.feeCollectorAddress,
      ]);

      eventPayloadsBeforeExecution = map(
        (event) => event.data,
        (
          await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
            get_events_by_resource_id: { resource_id: vaultId },
          })
        ).events,
      );

      while (dayjs((await this.cosmWasmClient.getBlock()).header.time).isBefore(targetTime)) {
        await setTimeout(3000);
      }

      await execute(this.cosmWasmClient, this.adminContractAddress, this.dcaContractAddress, {
        execute_trigger: {
          trigger_id: vaultId,
        },
      });

      vaultAfterExecution = (
        await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
          get_vault: {
            vault_id: vaultId,
          },
        })
      ).vault;

      balancesAfterExecution = await getBalances(this.cosmWasmClient, [
        this.userWalletAddress,
        this.dcaContractAddress,
        this.feeCollectorAddress,
      ]);

      eventPayloadsAfterExecution = map(
        (event) => event.data,
        (
          await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
            get_events_by_resource_id: { resource_id: vaultId },
          })
        ).events,
      );

      executionTriggeredEvent = find(
        (event) => 'dca_vault_execution_triggered' in event,
        eventPayloadsAfterExecution,
      ) as EventData;

      const receivedAmountBeforePoolFee = Math.floor(
        parseInt(vaultAfterExecution.swap_amount) /
          parseFloat(
            'dca_vault_execution_triggered' in executionTriggeredEvent &&
              executionTriggeredEvent.dca_vault_execution_triggered.asset_price,
          ),
      );
      receivedAmount = Math.floor(receivedAmountBeforePoolFee - receivedAmountBeforePoolFee * this.osmosisSwapFee);
      receivedAmountAfterFee = Math.floor(receivedAmount - receivedAmount * this.calcSwapFee);
    });

    it('reduces the vault balance', async function (this: Context) {
      expect(vaultAfterExecution.balance.amount).to.equal(
        `${parseInt(vaultBeforeExecution.balance.amount) - parseInt(vaultBeforeExecution.swap_amount)}`,
      );
    });

    it('sends funds back to the user', async function (this: Context) {
      expect(balancesAfterExecution[this.userWalletAddress]['uion']).to.equal(
        balancesBeforeExecution[this.userWalletAddress]['uion'] + parseInt(vaultAfterExecution.received_amount.amount),
      );
    });

    it('sends fees to the fee collector', async function (this: Context) {
      const totalFees = Math.floor(receivedAmount * this.calcSwapFee);
      expect(balancesAfterExecution[this.feeCollectorAddress]['uion']).to.equal(
        balancesBeforeExecution[this.feeCollectorAddress]['uion'] + totalFees,
      );
    });

    it('updates the vault swapped amount correctly', () =>
      expect(vaultAfterExecution.swapped_amount.amount).to.eql(
        `${parseInt(vaultBeforeExecution.swapped_amount.amount) + parseInt(vaultBeforeExecution.swap_amount)}`,
      ));

    it('updates the vault received amount correctly', () =>
      expect(vaultAfterExecution.received_amount).to.eql(coin(receivedAmountAfterFee + 1, 'uion')));

    it('creates a new time trigger', () =>
      expect('time' in vaultAfterExecution.trigger && vaultAfterExecution.trigger.time.target_time).to.eql(
        `${targetTime.add(1, 'hour').unix()}000000000`,
      ));

    it('adds the correct number of events', () =>
      expect(eventPayloadsAfterExecution.length).to.eql(eventPayloadsBeforeExecution.length + 2));

    it('has an execution triggered event', function (this: Context) {
      expect(eventPayloadsAfterExecution).to.include.deep.members([
        {
          dca_vault_execution_triggered: {
            asset_price:
              'dca_vault_execution_triggered' in executionTriggeredEvent &&
              executionTriggeredEvent.dca_vault_execution_triggered?.asset_price,
            base_denom: vaultAfterExecution.balance.denom,
            quote_denom: vaultAfterExecution.received_amount.denom,
          },
        },
      ]);
    });

    it('has an execution completed event', function (this: Context) {
      expect(eventPayloadsAfterExecution).to.include.deep.members([
        {
          dca_vault_execution_completed: {
            sent: coin(vaultAfterExecution.swap_amount, vaultAfterExecution.balance.denom),
            received: coin(`${receivedAmount}`, vaultAfterExecution.received_amount.denom),
            fee: coin(Math.round(receivedAmount * this.calcSwapFee), vaultAfterExecution.received_amount.denom),
          },
        },
      ]);
    });

    it('makes the vault active', () =>
      expect(vaultBeforeExecution.status).to.eql('scheduled') && expect(vaultAfterExecution.status).to.eql('active'));
  });

  describe('until the vault balance is empty', () => {
    let vault: Vault;
    const deposit = coin(1000000, 'uion');

    before(async function (this: Context) {
      const vaultId = await createVault(this, {
        time_interval: 'every_second',
      });

      vault = (
        await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
          get_vault: {
            vault_id: vaultId,
          },
        })
      ).vault;

      while (vault.status == 'active') {
        await execute(this.cosmWasmClient, this.adminContractAddress, this.dcaContractAddress, {
          execute_trigger: {
            trigger_id: vaultId,
          },
        });

        vault = (
          await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
            get_vault: {
              vault_id: vaultId,
            },
          })
        ).vault;

        await setTimeout(1000);
      }
    });

    it('still has a trigger', () => expect(vault.trigger).to.not.eql(null));

    it('is inactive', () => expect(vault.status).to.eql('inactive'));

    it('has a zero balance', () => expect(vault.balance.amount).to.eql('0'));

    it('has a swapped amount equal to the total deposited', () =>
      expect(vault.swapped_amount.amount).to.eql(deposit.amount));

    it('deletes the final trigger on next execution', async function (this: Context) {
      await execute(this.cosmWasmClient, this.adminContractAddress, this.dcaContractAddress, {
        execute_trigger: {
          trigger_id: vault.id,
        },
      });

      vault = (
        await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
          get_vault: {
            vault_id: vault.id,
          },
        })
      ).vault;

      expect(vault.trigger).to.eql(null);
    });
  });

  describe('with a time trigger still in the future', () => {
    let vaultId: number;

    before(async function (this: Context) {
      vaultId = await createVault(this, {
        target_start_time_utc_seconds: `${dayjs().add(1, 'day').unix()}`,
      });
    });

    it('fails to execute with the correct error message', async function (this: Context) {
      await expect(
        execute(this.cosmWasmClient, this.adminContractAddress, this.dcaContractAddress, {
          execute_trigger: {
            trigger_id: vaultId,
          },
        }),
      ).to.be.rejectedWith(/trigger execution time has not yet elapsed/);
    });
  });

  describe('with an exceeded price ceiling', () => {
    let targetTime: Dayjs;
    let vaultBeforeExecution: Vault;
    let vaultAfterExecution: Vault;
    let balancesBeforeExecution: Record<string, number>;
    let balancesAfterExecution: Record<string, number>;
    let eventPayloadsBeforeExecution: EventData[];
    let eventPayloadsAfterExecution: EventData[];

    before(async function (this: Context) {
      targetTime = dayjs().add(10, 'seconds');
      const swapAmount = 100000;

      const vaultId = await createVault(this, {
        target_start_time_utc_seconds: `${targetTime.unix()}`,
        swap_amount: `${swapAmount}`,
        minimum_receive_amount: `${swapAmount * 20}`,
      });

      vaultBeforeExecution = (
        await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
          get_vault: {
            vault_id: vaultId,
          },
        })
      ).vault;

      balancesBeforeExecution = await getBalances(this.cosmWasmClient, [
        this.userWalletAddress,
        this.dcaContractAddress,
        this.finPairAddress,
        this.feeCollectorAddress,
      ]);

      eventPayloadsBeforeExecution = map(
        (event) => event.data,
        (
          await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
            get_events_by_resource_id: { resource_id: vaultId },
          })
        ).events,
      );

      while (dayjs().isBefore(targetTime)) {
        await setTimeout(3000);
      }

      await execute(this.cosmWasmClient, this.adminContractAddress, this.dcaContractAddress, {
        execute_trigger: {
          trigger_id: vaultId,
        },
      });

      vaultAfterExecution = (
        await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
          get_vault: {
            vault_id: vaultId,
          },
        })
      ).vault;

      balancesAfterExecution = await getBalances(this.cosmWasmClient, [
        this.userWalletAddress,
        this.dcaContractAddress,
        this.finPairAddress,
        this.feeCollectorAddress,
      ]);

      eventPayloadsAfterExecution = map(
        (event) => event.data,
        (
          await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
            get_events_by_resource_id: { resource_id: vaultId },
          })
        ).events,
      );
    });

    it("doesn't reduce the vault balance", async () =>
      expect(vaultAfterExecution.balance.amount).to.equal(`${parseInt(vaultBeforeExecution.balance.amount)}`));

    it('sends no funds back to the user', async function (this: Context) {
      expect(balancesAfterExecution[this.userWalletAddress]['uosmo']).to.equal(
        balancesBeforeExecution[this.userWalletAddress]['uosmo'],
      );
    });

    it('sends no fees to the fee collector', async function (this: Context) {
      expect(balancesAfterExecution[this.feeCollectorAddress]['uosmo']).to.equal(
        balancesBeforeExecution[this.feeCollectorAddress]['uosmo'],
      );
    });

    it("doesn't update the vault swapped amount", () =>
      expect(vaultAfterExecution.swapped_amount.amount).to.eql(
        `${parseInt(vaultBeforeExecution.swapped_amount.amount)}`,
      ));

    it("doesn't update the vault received amount", () =>
      expect(vaultAfterExecution.received_amount).to.eql(vaultBeforeExecution.received_amount));

    it('creates a new time trigger', () =>
      expect('time' in vaultAfterExecution.trigger && vaultAfterExecution.trigger.time.target_time).to.eql(
        `${targetTime.add(1, 'hour').unix()}000000000`,
      ));

    it('adds the correct number of events', () =>
      expect(eventPayloadsAfterExecution.length).to.eql(eventPayloadsBeforeExecution.length + 2));

    it('has an execution triggered event', function (this: Context) {
      expect(eventPayloadsAfterExecution).to.include.deep.members([
        {
          dca_vault_execution_triggered: {
            asset_price: `${this.finBuyPrice}`,
            base_denom: 'uosmo',
            quote_denom: vaultAfterExecution.balance.denom,
          },
        },
      ]);
    });

    it('has an execution skipped event', function (this: Context) {
      expect(eventPayloadsAfterExecution).to.include.deep.members([
        {
          dca_vault_execution_skipped: {
            reason: {
              price_threshold_exceeded: {
                price: `${this.finBuyPrice}`,
              },
            },
          },
        },
      ]);
    });

    it('makes the vault active', () =>
      expect(vaultBeforeExecution.status).to.eql('scheduled') && expect(vaultAfterExecution.status).to.eql('active'));
  });

  describe('with exceeded slippage', () => {
    let targetTime: Dayjs;
    let vaultBeforeExecution: Vault;
    let vaultAfterExecution: Vault;
    let balancesBeforeExecution: Record<string, number>;
    let balancesAfterExecution: Record<string, number>;
    let eventPayloadsBeforeExecution: EventData[];
    let eventPayloadsAfterExecution: EventData[];

    before(async function (this: Context) {
      // const finPairAddress = await instantiateFinPairContract(
      //   this.cosmWasmClient,
      //   this.adminContractAddress,
      //   'uosmo',
      //   'uion',
      //   5,
      //   [
      //     { price: 1, amount: coin('100000000', 'uosmo') },
      //     { price: 0.2, amount: coin('1000', 'uosmo') },
      //     { price: 0.1, amount: coin('100000000', 'uosmo') },
      //   ],
      // );

      // const pair = await this.cosmWasmClient.queryContractSmart(finPairAddress, {
      //   config: {},
      // });

      // await execute(this.cosmWasmClient, this.adminContractAddress, this.dcaContractAddress, {
      //   create_pool: {
      //     base_denom: pair.denoms[0].native,
      //     quote_denom: pair.denoms[1].native,
      //     pool_id: 1,
      //   },
      // });

      targetTime = dayjs().add(10, 'seconds');

      const vaultId = await createVault(
        this,
        {
          target_start_time_utc_seconds: `${targetTime.unix()}`,
          swap_amount: '100000000',
          slippage_tolerance: '0.0001',
          // pair_address: finPairAddress,
        },
        [coin('1000000000', 'uion')],
      );

      vaultBeforeExecution = (
        await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
          get_vault: {
            vault_id: vaultId,
          },
        })
      ).vault;

      balancesBeforeExecution = await getBalances(this.cosmWasmClient, [
        this.userWalletAddress,
        this.dcaContractAddress,
        this.finPairAddress,
        this.feeCollectorAddress,
      ]);

      eventPayloadsBeforeExecution = map(
        (event) => event.data,
        (
          await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
            get_events_by_resource_id: { resource_id: vaultId },
          })
        ).events,
      );

      while (dayjs().isBefore(targetTime)) {
        await setTimeout(3000);
      }

      await execute(this.cosmWasmClient, this.adminContractAddress, this.dcaContractAddress, {
        execute_trigger: {
          trigger_id: vaultId,
        },
      });

      vaultAfterExecution = (
        await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
          get_vault: {
            vault_id: vaultId,
          },
        })
      ).vault;

      balancesAfterExecution = await getBalances(this.cosmWasmClient, [
        this.userWalletAddress,
        this.dcaContractAddress,
        this.finPairAddress,
        this.feeCollectorAddress,
      ]);

      eventPayloadsAfterExecution = map(
        (event) => event.data,
        (
          await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
            get_events_by_resource_id: { resource_id: vaultId },
          })
        ).events,
      );
    });

    it("doesn't reduce the vault balance", async () =>
      expect(vaultAfterExecution.balance.amount).to.equal(`${parseInt(vaultBeforeExecution.balance.amount)}`));

    it('sends no funds back to the user', async function (this: Context) {
      expect(balancesAfterExecution[this.userWalletAddress]['uosmo']).to.equal(
        balancesBeforeExecution[this.userWalletAddress]['uosmo'],
      );
    });

    it('sends no fees to the fee collector', async function (this: Context) {
      expect(balancesAfterExecution[this.feeCollectorAddress]['uosmo']).to.equal(
        balancesBeforeExecution[this.feeCollectorAddress]['uosmo'],
      );
    });

    it("doesn't update the vault swapped amount", () =>
      expect(vaultAfterExecution.swapped_amount.amount).to.eql(
        `${parseInt(vaultBeforeExecution.swapped_amount.amount)}`,
      ));

    it("doesn't update the vault received amount", () =>
      expect(vaultAfterExecution.received_amount).to.eql(vaultBeforeExecution.received_amount));

    it('creates a new time trigger', () =>
      expect('time' in vaultAfterExecution.trigger && vaultAfterExecution.trigger.time.target_time).to.eql(
        `${targetTime.add(1, 'hour').unix()}000000000`,
      ));

    it('adds the correct number of events', () =>
      expect(eventPayloadsAfterExecution.length).to.eql(eventPayloadsBeforeExecution.length + 2));

    it('has an execution triggered event', function (this: Context) {
      expect(eventPayloadsAfterExecution).to.include.deep.members([
        {
          dca_vault_execution_triggered: {
            asset_price: '0.1',
            base_denom: 'uosmo',
            quote_denom: vaultAfterExecution.balance.denom,
          },
        },
      ]);
    });

    it('has an execution skipped event', function (this: Context) {
      expect(eventPayloadsAfterExecution).to.include.deep.members([
        {
          dca_vault_execution_skipped: {
            reason: 'slippage_tolerance_exceeded',
          },
        },
      ]);
    });

    it('makes the vault active', () =>
      expect(vaultBeforeExecution.status).to.eql('scheduled') && expect(vaultAfterExecution.status).to.eql('active'));
  });

  describe('with insufficient funds afterwards', () => {
    let targetTime: Dayjs;
    let vaultBeforeExecution: Vault;
    let vaultAfterExecution: Vault;
    let balancesBeforeExecution: Record<string, number>;
    let balancesAfterExecution: Record<string, number>;
    let eventPayloadsBeforeExecution: EventData[];
    let eventPayloadsAfterExecution: EventData[];
    let receivedAmount: number;
    let receivedAmountAfterFee: number;

    before(async function (this: Context) {
      const swapAmount = 100000;
      targetTime = dayjs().add(10, 'seconds');

      const vaultId = await createVault(
        this,
        {
          target_start_time_utc_seconds: `${targetTime.unix()}`,
          swap_amount: `${swapAmount}`,
          slippage_tolerance: '0.0001',
        },
        [coin('110000', 'uion')],
      );

      vaultBeforeExecution = (
        await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
          get_vault: {
            vault_id: vaultId,
          },
        })
      ).vault;

      balancesBeforeExecution = await getBalances(this.cosmWasmClient, [
        this.userWalletAddress,
        this.dcaContractAddress,
        this.finPairAddress,
        this.feeCollectorAddress,
      ]);

      eventPayloadsBeforeExecution = map(
        (event) => event.data,
        (
          await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
            get_events_by_resource_id: { resource_id: vaultId },
          })
        ).events,
      );

      while (dayjs().isBefore(targetTime)) {
        await setTimeout(3000);
      }

      await execute(this.cosmWasmClient, this.adminContractAddress, this.dcaContractAddress, {
        execute_trigger: {
          trigger_id: vaultId,
        },
      });

      vaultAfterExecution = (
        await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
          get_vault: {
            vault_id: vaultId,
          },
        })
      ).vault;

      balancesAfterExecution = await getBalances(this.cosmWasmClient, [
        this.userWalletAddress,
        this.dcaContractAddress,
        this.finPairAddress,
        this.feeCollectorAddress,
      ]);

      eventPayloadsAfterExecution = map(
        (event) => event.data,
        (
          await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
            get_events_by_resource_id: { resource_id: vaultId },
          })
        ).events,
      );

      receivedAmount = Math.round((swapAmount - swapAmount * this.osmosisSwapFee) / this.finBuyPrice);
      receivedAmountAfterFee = Math.round(receivedAmount - Math.floor(receivedAmount * this.calcSwapFee));
    });

    it('reduces the vault balance', async function (this: Context) {
      expect(vaultAfterExecution.balance.amount).to.equal(
        `${parseInt(vaultBeforeExecution.balance.amount) - parseInt(vaultBeforeExecution.swap_amount)}`,
      );
    });

    it('sends funds back to the user', async function (this: Context) {
      expect(balancesAfterExecution[this.userWalletAddress]['uosmo']).to.equal(
        balancesBeforeExecution[this.userWalletAddress]['uosmo'] + parseInt(vaultAfterExecution.received_amount.amount),
      );
    });

    it('sends fees to the fee collector', async function (this: Context) {
      const totalFees = Math.floor(receivedAmount * this.calcSwapFee);
      expect(balancesAfterExecution[this.feeCollectorAddress]['uosmo']).to.equal(
        balancesBeforeExecution[this.feeCollectorAddress]['uosmo'] + totalFees,
      );
    });

    it('updates the vault swapped amount correctly', () =>
      expect(vaultAfterExecution.swapped_amount.amount).to.eql(
        `${parseInt(vaultBeforeExecution.swapped_amount.amount) + parseInt(vaultBeforeExecution.swap_amount)}`,
      ));

    it('updates the vault received amount correctly', () =>
      expect(vaultAfterExecution.received_amount).to.eql(coin(receivedAmountAfterFee, 'uosmo')));

    it("doesn't create a new trigger", () => expect(vaultAfterExecution.trigger === null));

    it('adds the correct number of events', () =>
      expect(eventPayloadsAfterExecution.length).to.eql(eventPayloadsBeforeExecution.length + 2));

    it('has an execution triggered event', function (this: Context) {
      expect(eventPayloadsAfterExecution).to.include.deep.members([
        {
          dca_vault_execution_triggered: {
            asset_price: `${this.finBuyPrice}`,
            base_denom: 'uosmo',
            quote_denom: vaultAfterExecution.balance.denom,
          },
        },
      ]);
    });

    it('has an execution completed event', function (this: Context) {
      expect(eventPayloadsAfterExecution).to.include.deep.members([
        {
          dca_vault_execution_completed: {
            sent: coin(vaultAfterExecution.swap_amount, vaultAfterExecution.balance.denom),
            received: coin(`${receivedAmount}`, 'uosmo'),
            fee: coin(Math.round(receivedAmount * this.calcSwapFee), 'uosmo'),
          },
        },
      ]);
    });
  });

  // describe('with dca plus', () => {
  //   const deposit = coin(1000000, 'uosmo');
  //   let vault: Vault;
  //   let balancesBeforeExecution: Record<string, number>;
  //   let balancesAfterExecution: Record<string, number>;
  //   let expectedPrice: number;

  //   before(async function (this: Context) {
  //     balancesBeforeExecution = await getBalances(this.cosmWasmClient, [this.userWalletAddress], ['uion']);

  //     const targetTime = dayjs().add(10, 'seconds');

  //     const vault_id = await createVault(
  //       this,
  //       {
  //         target_start_time_utc_seconds: `${targetTime.unix()}`,
  //         time_interval: 'every_second',
  //         use_dca_plus: true,
  //       },
  //       [deposit],
  //     );

  //     while (dayjs().isBefore(targetTime)) {
  //       await setTimeout(3000);
  //     }

  //     await execute(this.cosmWasmClient, this.adminContractAddress, this.dcaContractAddress, {
  //       execute_trigger: {
  //         trigger_id: vault_id,
  //       },
  //     });

  //     vault = (
  //       await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
  //         get_vault: {
  //           vault_id,
  //         },
  //       })
  //     ).vault;

  //     expectedPrice = await this.cosmWasmClient.queryContractSmart(this.swapContractAddress, {
  //       get_price: {
  //         swap_amount: coin(vault.swap_amount, 'uosmo'),
  //         target_denom: 'uion',
  //         price_type: 'actual',
  //       },
  //     });

  //     balancesAfterExecution = await getBalances(this.cosmWasmClient, [this.userWalletAddress], ['uion']);
  //   });

  //   it('subtracts the escrowed balance from the disbursed amount', async function (this: Context) {
  //     expect(balancesAfterExecution[this.userWalletAddress]['uion']).to.equal(
  //       Math.round(
  //         balancesBeforeExecution[this.userWalletAddress]['uion'] +
  //           parseInt(vault.received_amount.amount) -
  //           parseInt(vault.dca_plus_config.escrowed_balance.amount),
  //       ),
  //     );
  //   });

  //   it('stores the escrowed balance', async function (this: Context) {
  //     expect(vault.dca_plus_config.escrowed_balance.amount).to.equal(
  //       `${Math.floor(parseInt(vault.received_amount.amount) * parseFloat(vault.dca_plus_config.escrow_level))}`,
  //     );
  //   });

  //   it('calculates the standard dca swapped amount', async function (this: Context) {
  //     expect(vault.dca_plus_config.standard_dca_swapped_amount.amount).to.equal(
  //       `${parseInt(vault.swapped_amount.amount) / this.swapAdjustment}`,
  //     );
  //   });

  //   it('calculates the standard dca received amount', async function (this: Context) {
  //     expect(vault.dca_plus_config.standard_dca_received_amount.amount).to.equal(
  //       `${Math.round((parseInt(vault.swap_amount) / expectedPrice) * (1 - this.calcSwapFee - this.finTakerFee))}`,
  //     );
  //   });
  // });

  // describe('with finished dca plus and unfinished standard dca', () => {
  //   const deposit = coin(1000000, 'uosmo');
  //   const swapAdjustment = 1.8;

  //   let vault: Vault;
  //   let balancesBeforeExecution: Record<string, number>;
  //   let balancesAfterExecution: Record<string, number>;

  //   before(async function (this: Context) {
  //     balancesBeforeExecution = await getBalances(
  //       this.cosmWasmClient,
  //       [this.userWalletAddress, this.feeCollectorAddress],
  //       ['uion'],
  //     );

  //     for (const position_type of ['enter', 'exit']) {
  //       await execute(this.cosmWasmClient, this.adminContractAddress, this.dcaContractAddress, {
  //         update_swap_adjustments: {
  //           position_type,
  //           adjustments: [
  //             [30, `${swapAdjustment}`],
  //             [35, `${swapAdjustment}`],
  //             [40, `${swapAdjustment}`],
  //             [45, `${swapAdjustment}`],
  //             [50, `${swapAdjustment}`],
  //             [55, `${swapAdjustment}`],
  //             [60, `${swapAdjustment}`],
  //             [70, `${swapAdjustment}`],
  //             [80, `${swapAdjustment}`],
  //             [90, `${swapAdjustment}`],
  //           ],
  //         },
  //       });
  //     }

  //     const targetTime = dayjs().add(10, 'seconds');

  //     const vault_id = await createVault(
  //       this,
  //       {
  //         target_start_time_utc_seconds: `${targetTime.unix()}`,
  //         swap_amount: `${Math.round(parseInt(deposit.amount) * (2 / 3))}`,
  //         time_interval: 'every_second',
  //         use_dca_plus: true,
  //       },
  //       [deposit],
  //     );

  //     while (dayjs().isBefore(targetTime)) {
  //       await setTimeout(3000);
  //     }

  //     await execute(this.cosmWasmClient, this.adminContractAddress, this.dcaContractAddress, {
  //       execute_trigger: {
  //         trigger_id: vault_id,
  //       },
  //     });

  //     vault = (
  //       await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
  //         get_vault: {
  //           vault_id,
  //         },
  //       })
  //     ).vault;

  //     balancesAfterExecution = await getBalances(this.cosmWasmClient, [this.userWalletAddress], ['uion']);
  //   });

  //   it('subtracts the escrowed balance from the disbursed amount', async function (this: Context) {
  //     expect(balancesAfterExecution[this.userWalletAddress]['uion']).to.equal(
  //       Math.round(
  //         balancesBeforeExecution[this.userWalletAddress]['uion'] +
  //           parseInt(vault.received_amount.amount) -
  //           parseInt(vault.dca_plus_config.escrowed_balance.amount),
  //       ),
  //     );
  //   });

  //   it('stores the escrowed balance', async function (this: Context) {
  //     expect(vault.dca_plus_config.escrowed_balance.amount).to.equal(
  //       `${Math.floor(parseInt(vault.received_amount.amount) * parseFloat(vault.dca_plus_config.escrow_level))}`,
  //     );
  //   });

  //   it('has swapped all the vault balance', () => {
  //     expect(vault.balance.amount).to.equal('0');
  //     expect(vault.swapped_amount.amount).to.equal(deposit.amount);
  //   });

  //   it('sets the vault status to inactive', () => expect(vault.status).to.equal('inactive'));

  //   it('still has a time trigger', () =>
  //     expect(vault.trigger).to.eql({
  //       time: { target_time: 'time' in vault.trigger && vault.trigger.time.target_time },
  //     }));

  //   describe('once standard dca finishes', () => {
  //     let performanceFee: number;

  //     before(async function (this: Context) {
  //       await execute(this.cosmWasmClient, this.adminContractAddress, this.dcaContractAddress, {
  //         execute_trigger: {
  //           trigger_id: vault.id,
  //         },
  //       });

  //       vault = (
  //         await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
  //           get_vault: {
  //             vault_id: vault.id,
  //           },
  //         })
  //       ).vault;

  //       balancesAfterExecution = await getBalances(
  //         this.cosmWasmClient,
  //         [this.userWalletAddress, this.feeCollectorAddress],
  //         ['uion'],
  //       );

  //       performanceFee = Math.floor(
  //         (parseInt(vault.received_amount.amount) -
  //           parseInt(vault.dca_plus_config.standard_dca_received_amount.amount)) *
  //           0.2,
  //       );
  //     });

  //     it('empties the escrow balance', () => expect(vault.dca_plus_config.escrowed_balance.amount).to.equal('0'));

  //     it('pays out the escrow', function (this: Context) {
  //       expect(balancesAfterExecution[this.userWalletAddress]['uion']).to.equal(
  //         balancesBeforeExecution[this.userWalletAddress]['uion'] +
  //           parseInt(vault.received_amount.amount) -
  //           performanceFee,
  //       );
  //     });

  //     it('pays out the performance fee', function (this: Context) {
  //       expect(balancesAfterExecution[this.feeCollectorAddress]['uion']).to.equal(
  //         balancesBeforeExecution[this.feeCollectorAddress]['uion'] + performanceFee,
  //       );
  //     });
  //   });
  // });

  // describe('with finished standard dca and unfinished dca plus', () => {
  //   const deposit = coin(1000000, 'uosmo');
  //   const swapAdjustment = 0.8;

  //   let vault: Vault;
  //   let balancesBeforeExecution: Record<string, number>;
  //   let balancesAfterExecution: Record<string, number>;

  //   before(async function (this: Context) {
  //     balancesBeforeExecution = await getBalances(
  //       this.cosmWasmClient,
  //       [this.userWalletAddress, this.feeCollectorAddress],
  //       ['uion'],
  //     );

  //     for (const position_type of ['enter', 'exit']) {
  //       await execute(this.cosmWasmClient, this.adminContractAddress, this.dcaContractAddress, {
  //         update_swap_adjustments: {
  //           position_type,
  //           adjustments: [
  //             [30, `${swapAdjustment}`],
  //             [35, `${swapAdjustment}`],
  //             [40, `${swapAdjustment}`],
  //             [45, `${swapAdjustment}`],
  //             [50, `${swapAdjustment}`],
  //             [55, `${swapAdjustment}`],
  //             [60, `${swapAdjustment}`],
  //             [70, `${swapAdjustment}`],
  //             [80, `${swapAdjustment}`],
  //             [90, `${swapAdjustment}`],
  //           ],
  //         },
  //       });
  //     }

  //     const targetTime = dayjs().add(10, 'seconds');

  //     const vault_id = await createVault(
  //       this,
  //       {
  //         target_start_time_utc_seconds: `${targetTime.unix()}`,
  //         swap_amount: deposit.amount,
  //         time_interval: 'every_second',
  //         use_dca_plus: true,
  //       },
  //       [deposit],
  //     );

  //     while (dayjs().isBefore(targetTime)) {
  //       await setTimeout(3000);
  //     }

  //     await execute(this.cosmWasmClient, this.adminContractAddress, this.dcaContractAddress, {
  //       execute_trigger: {
  //         trigger_id: vault_id,
  //       },
  //     });

  //     vault = (
  //       await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
  //         get_vault: {
  //           vault_id,
  //         },
  //       })
  //     ).vault;

  //     balancesAfterExecution = await getBalances(this.cosmWasmClient, [this.userWalletAddress], ['uion']);
  //   });

  //   it('subtracts the escrowed balance from the disbursed amount', async function (this: Context) {
  //     expect(balancesAfterExecution[this.userWalletAddress]['uion']).to.equal(
  //       Math.round(
  //         balancesBeforeExecution[this.userWalletAddress]['uion'] +
  //           parseInt(vault.received_amount.amount) -
  //           parseInt(vault.dca_plus_config.escrowed_balance.amount),
  //       ),
  //     );
  //   });

  //   it('stores the escrowed balance', async function (this: Context) {
  //     expect(vault.dca_plus_config.escrowed_balance.amount).to.equal(
  //       `${Math.floor(parseInt(vault.received_amount.amount) * parseFloat(vault.dca_plus_config.escrow_level))}`,
  //     );
  //   });

  //   it('has swapped all the standard vault balance', () => {
  //     expect(vault.dca_plus_config.standard_dca_swapped_amount.amount).to.equal(deposit.amount);
  //   });

  //   it('has not swapped all the dca plus vault balance', () =>
  //     expect(parseInt(vault.swapped_amount.amount)).to.equal(parseInt(deposit.amount) * swapAdjustment));

  //   it('vault is still active', () => expect(vault.status).to.equal('active'));

  //   it('still has a time trigger', () =>
  //     expect(vault.trigger).to.eql({
  //       time: { target_time: 'time' in vault.trigger && vault.trigger.time.target_time },
  //     }));

  //   describe('once dca plus finishes', () => {
  //     let performanceFee: number;

  //     before(async function (this: Context) {
  //       await execute(this.cosmWasmClient, this.adminContractAddress, this.dcaContractAddress, {
  //         execute_trigger: {
  //           trigger_id: vault.id,
  //         },
  //       });

  //       vault = (
  //         await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
  //           get_vault: {
  //             vault_id: vault.id,
  //           },
  //         })
  //       ).vault;

  //       balancesAfterExecution = await getBalances(
  //         this.cosmWasmClient,
  //         [this.userWalletAddress, this.feeCollectorAddress],
  //         ['uion'],
  //       );

  //       performanceFee = Math.floor(
  //         (parseInt(vault.received_amount.amount) -
  //           parseInt(vault.dca_plus_config.standard_dca_received_amount.amount)) *
  //           0.2,
  //       );
  //     });

  //     it('has swapped all the balance', () => {
  //       expect(vault.swapped_amount.amount).to.equal(deposit.amount);
  //     });

  //     it('empties the escrow balance', () => expect(vault.dca_plus_config.escrowed_balance.amount).to.equal('0'));

  //     it('pays out the escrow', function (this: Context) {
  //       expect(balancesAfterExecution[this.userWalletAddress]['uion']).to.equal(
  //         balancesBeforeExecution[this.userWalletAddress]['uion'] +
  //           parseInt(vault.received_amount.amount) -
  //           performanceFee,
  //       );
  //     });

  //     it('pays out the performance fee', function (this: Context) {
  //       expect(balancesAfterExecution[this.feeCollectorAddress]['uion']).to.equal(
  //         balancesBeforeExecution[this.feeCollectorAddress]['uion'] + performanceFee,
  //       );
  //     });

  //     it('sets the vault to inactive', () => expect(vault.status).to.equal('inactive'));

  //     it('does not have a trigger', () => expect(vault.trigger).to.equal(null));
  //   });
  // });
});
