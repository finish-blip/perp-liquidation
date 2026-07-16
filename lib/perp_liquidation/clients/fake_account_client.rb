# frozen_string_literal: true

module PerpLiquidation
  class FakeAccountClient
    def initialize(accounts = [])
      @accounts = {}
      accounts.each { |account| put(account) }
    end

    def put(account)
      @accounts[account.account_id] = account
    end

    def find(account_id:)
      @accounts.fetch(account_id.to_s) { raise PreconditionsFailed, "account #{account_id} not found" }
    end
  end
end
