import crypto from 'bitcoinjs-lib/src/crypto'
import SwapApp, { constants } from 'swap.app'
import { Flow } from 'swap.swap'

class Tx {
  constructor(hash, hex) {
    this.hash = hash
    this.hex = hex
  }
}

export default (tokenName) => {

  class USDT2ETHTOKEN extends Flow {

    static getName() {
      return `${constants.COINS.usdt}2${tokenName.toUpperCase()}`
    }

    constructor(swap) {
      super(swap)

      this._flowName = USDT2ETHTOKEN.getName()

      this.ethTokenSwap = SwapApp.swaps[tokenName.toUpperCase()]
      this.usdtSwap      = SwapApp.swaps[constants.COINS.usdt]

      this.myBtcAddress = SwapApp.services.auth.accounts.btc.getAddress()
      this.myEthAddress = SwapApp.services.auth.accounts.eth.address

      this.stepNumbers = {
        'sign': 1,
        'submit-secret': 2,
        'sync-balance': 3,
        'lock-usdt': 4,
        'wait-lock-eth': 5,
        'withdraw-eth': 6,
        'finish': 7,
        'end': 8
      }

      if (!this.ethTokenSwap) {
        throw new Error('USDT2ETH: "ethTokenSwap" of type object required')
      }
      if (!this.usdtSwap) {
        throw new Error('USDT2ETH: "usdtSwap" of type object required')
      }

      this.state = {
        step: 0,

        signTransactionHash: null,
        isSignFetching: false,
        isParticipantSigned: false,

        // btcScriptCreatingTransactionHash: null,
        usdtFundingTransactionHash: null,
        usdtRawRedeemTransactionHex: null,

        ethSwapCreationTransactionHash: null,

        secretHash: null,
        usdtScriptValues: null,

        usdtScriptVerified: false,

        isBalanceFetching: false,
        isBalanceEnough: false,
        balance: null,

        isEthContractFunded: false,

        ethSwapWithdrawTransactionHash: null,
        isEthWithdrawn: false,
        isBtcWithdrawn: false,

        refundTxHex: null,
        isFinished: false,
      }

      super._persistSteps()
      this._persistState()
    }

    _persistState() {
      super._persistState()
    }

    _getSteps() {
      const flow = this

      return [

        // 1. Signs

        () => {
          flow.swap.room.once('swap sign', () => {
            console.log('swap sign!')
            flow.finishStep({
              isParticipantSigned: true,
            }, { step: 'sign', silentError: true })
          })

          flow.swap.room.once('swap exists', () => {
            console.log(`swap already exists`)
          })

          // if I came late and he ALREADY send this, I request AGAIN
          flow.swap.room.sendMessage('request sign')
        },

        // 2. Create secret, secret hash

        () => {
          // this.submitSecret()
        },

        // 3. Check balance

        () => {
          this.syncBalance()
        },

        // 4. Create USDT Script, fund, notify participant

        async () => {
          const { sellAmount, participant } = flow.swap
          const { usdtScriptValues } = flow.state
          let usdtFundingTransactionHash, usdtFunding

          // TODO move this somewhere!
          const utcNow = () => Math.floor(Date.now() / 1000)
          const getLockTime = () => utcNow() + 3600 * 3 // 3 hours from now

          let scriptValues

          if (!usdtScriptValues) {
            scriptValues = {
              secretHash:         flow.state.secretHash,
              ownerPublicKey:     SwapApp.services.auth.accounts.btc.getPublicKey(),
              recipientPublicKey: participant.btc.publicKey,
              lockTime:           getLockTime(),
            }

            flow.setState({
              usdtScriptValues: scriptValues,
            })
          } else {
            scriptValues = usdtScriptValues
          }

          console.log('sellAmount', sellAmount)

          await flow.usdtSwap.fundScript(
            { scriptValues },
            (hash, funding) => {
              usdtFundingTransactionHash = hash
              usdtFunding = funding

              flow.setState({
                usdtFundingTransactionHash: hash,
              })
            })

          const fundingValues = {
            txid: usdtFundingTransactionHash,
            scriptAddress: usdtFunding.scriptValues.scriptAddress,
          }

          const rawRedeemHex = await flow.usdtSwap.buildRawRedeemTransaction({
            scriptValues,
            fundingValues,
            amount: sellAmount,
          })

          flow.swap.room.on('request btc script', () => {
            flow.swap.room.sendMessage('create btc script', {
              scriptValues,
              fundingValues,
              usdtFundingTransactionHash,
              rawRedeemHex,
            })
          })

          flow.swap.room.sendMessage('create btc script', {
            scriptValues,
            usdtFundingTransactionHash,
            rawRedeemHex,
          })

          flow.finishStep({
            isBtcScriptFunded: true,
            usdtScriptValues: scriptValues,
            usdtRawRedeemTransactionHex: rawRedeemHex,
          })

          // leave only when we have and the party has all values
          // scriptValues: secretHash, lockTime
          // funding: txHash
          // redeem: txHex
        },

        // 5. Wait participant creates ETH Contract

        () => {
          const { participant } = flow.swap
          let timer

          flow.swap.room.once('create eth contract', ({ ethSwapCreationTransactionHash }) => {
            flow.setState({
              ethSwapCreationTransactionHash,
            })
          })

          const checkEthBalance = () => {
            timer = setTimeout(async () => {
              const balance = await flow.ethTokenSwap.getBalance({
                ownerAddress: participant.eth.address,
              })

              if (balance > 0) {
                if (!flow.state.isEthContractFunded) { // redundant condition but who cares :D
                  flow.finishStep({
                    isEthContractFunded: true,
                  }, { step: 'wait-lock-eth' })
                }
              }
              else {
                checkEthBalance()
              }
            }, 20 * 1000)
          }

          checkEthBalance()

          flow.swap.room.once('create eth contract', () => {
            if (!flow.state.isEthContractFunded) {
              clearTimeout(timer)
              timer = null

              flow.finishStep({
                isEthContractFunded: true,
              }, { step: 'wait-lock-eth' })
            }
          })
        },

        // 6. Withdraw

        async () => {
          const { buyAmount, participant } = flow.swap

          const data = {
            ownerAddress:   participant.eth.address,
            secret:         flow.state.secret,
          }

          const balanceCheckResult = await flow.ethTokenSwap.checkBalance({
            ownerAddress: participant.eth.address,
            expectedValue: buyAmount,
          })

          if (balanceCheckResult) {
            console.error(`Waiting until deposit: ETH balance check error:`, balanceCheckResult)
            flow.swap.events.dispatch('eth balance check error', balanceCheckResult)
            return
          }

          try {
            await flow.ethTokenSwap.withdraw(data, (hash) => {
              flow.setState({
                ethSwapWithdrawTransactionHash: hash,
              })
            })
          } catch (err) {
            // TODO user can stuck here after page reload...
            if ( !/known transaction/.test(err.message) ) console.error(err)
            return
          }

          flow.swap.room.sendMessage('finish eth withdraw')

          flow.finishStep({
            isEthWithdrawn: true,
          })
        },

        // 7. Finish

        () => {
          flow.swap.room.once('swap finished', () => {
            flow.finishStep({
              isFinished: true,
            })
          })
        },

        // 8. Finished!
        () => {

        }
      ]
    }

    submitSecret(secret) {
      if (this.state.secretHash) return true
      if (!this.state.isParticipantSigned)
        throw new Error(`Cannot proceed: participant not signed. step=${this.state.step}`)

      const secretHash = crypto.ripemd160(Buffer.from(secret, 'hex')).toString('hex')

      this.finishStep({
        secret,
        secretHash,
      }, { step: 'submit-secret' })

      return true
    }

    async syncBalance() {
      const { sellAmount } = this.swap

      this.setState({
        isBalanceFetching: true,
      })

      const balance = await this.usdtSwap.fetchBalance(SwapApp.services.auth.accounts.btc.getAddress())
      const isEnoughMoney = sellAmount.isLessThanOrEqualTo(balance)

      if (isEnoughMoney) {
        this.finishStep({
          balance,
          isBalanceFetching: false,
          isBalanceEnough: true,
        }, { step: 'sync-balance' })
      }
      else {
        this.setState({
          balance,
          isBalanceFetching: false,
          isBalanceEnough: false,
        })
      }
    }

    getRefundTxHex = () => {
      this.usdtSwap.getRefundHexTransaction({
        scriptValues: this.state.usdtScriptValues,
        secret: this.state.secret,
      })
        .then((txHex) => {
          this.setState({
            refundTxHex: txHex,
          })
        })
    }

    tryRefund() {
      return this.usdtSwap.refund({
        scriptValues: this.state.usdtScriptValues,
        secret: this.state.secret,
      }, (hash) => {
        this.setState({
          refundTransactionHash: hash,
        })
      })
      .then(() => {
        this.setState({
          isRefunded: true,
        })
      })
    }
  }

  return USDT2ETHTOKEN
}
