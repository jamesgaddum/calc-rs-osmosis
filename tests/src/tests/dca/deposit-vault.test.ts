import dayjs, { Dayjs } from 'dayjs'
import { Context } from 'mocha'
import { execute } from '../../shared/cosmwasm'
import { Vault } from '../../types/dca/response/get_vault'
import { createVault } from '../helpers'
import { coin } from '@cosmjs/proto-signing';
import { expect } from '../shared.test'
import { EventData } from '../../types/dca/response/get_events'
import { map } from 'ramda'

describe('when depositing into a vault', () => {

    describe('with a status of scheduled', async () => {
        const swapAmount = 1000000
        const deposit = coin(`2000000`, 'stake')
        let vaultBeforeExecution: Vault
        let vaultAfterExecution: Vault
        let eventPayloads: EventData[]

        before(async function (this: Context) {
            const vault_id = await createVault(this, {
                swap_amount: `${swapAmount}`,
                target_start_time_utc_seconds: `${dayjs().add(1, 'hour').unix()}`,
            });
    
            vaultBeforeExecution = (
                await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
                    get_vault: {
                        vault_id,
                    },
                })
            ).vault
    
            await execute(this.cosmWasmClient, this.adminContractAddress, this.dcaContractAddress, {
                deposit: {
                    address: this.userWalletAddress,
                    vault_id,
                }
            },
                [deposit]
            )
    
            vaultAfterExecution = (
                await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
                    get_vault: {
                        vault_id,
                    },
                })
            ).vault

            eventPayloads = (
                map(
                    (event) => event.data,
                    (
                        await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
                          get_events_by_resource_id: { resource_id: vault_id },
                        })
                      ).events,
                )
            )
        })
    
        it('should deposit into the vault', async () => {
            expect(parseInt(vaultAfterExecution.balance.amount)).to.equal(parseInt(vaultBeforeExecution.balance.amount) + parseInt(deposit.amount))
        })

        it('has a funds deposited event', async () =>
            expect(eventPayloads).to.include.deep.members([{ dca_vault_funds_deposited: { amount: deposit } }]));
        
        it('should not change the vault status', async () => {
            expect(vaultAfterExecution.status).to.equal(vaultBeforeExecution.status)
        })
    })

    describe('with a status of inactive', async () => {
        const swapAmount = 1000000
        const creation_deposit = coin(`100`, 'stake')
        const deposit = coin(`1000000`, 'stake')
        let vaultAfterDeposit: Vault

        before(async function (this: Context) {

            const vault_id = await createVault(this, {
                swap_amount: `${swapAmount}`,
                pool_id: 1
            }, [creation_deposit]);

            await execute(this.cosmWasmClient, this.adminContractAddress, this.dcaContractAddress, {
                deposit: {
                    address: this.userWalletAddress,
                    vault_id,
                }
            },
                [deposit]
            )
    
            vaultAfterDeposit = (
                await this.cosmWasmClient.queryContractSmart(this.dcaContractAddress, {
                    get_vault: {
                        vault_id,
                    },
                })
            ).vault
        })
    
        // it.only('should change the vault status', async () => {
        //     expect(vaultAfterDeposit.status).to.equal('active')
        // })
    })
})