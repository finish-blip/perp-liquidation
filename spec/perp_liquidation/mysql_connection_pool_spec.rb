# frozen_string_literal: true

require 'spec_helper'

RSpec.describe PerpLiquidation::MysqlConnectionPool do
  Connection = Struct.new(:id, :queries) do
    def initialize(id)
      super(id, [])
    end

    def query(sql)
      queries << sql
      []
    end

    def escape(value)
      value
    end

    def close
      self
    end
  end

  it 'reuses the checked out connection for nested calls on the same thread' do
    next_id = 0
    pool = described_class.new(size: 2, checkout_timeout: 0.1) do
      next_id += 1
      Connection.new(next_id)
    end

    pool.with_connection do |outer|
      pool.with_connection do |inner|
        expect(inner).to equal(outer)
        expect(pool.current_connection).to equal(outer)
      end
    end
    expect(pool.current_connection).to be_nil
  end

  it 'gives concurrent threads different connections' do
    next_id = 0
    pool = described_class.new(size: 2, checkout_timeout: 0.1) do
      next_id += 1
      Connection.new(next_id)
    end
    entered = Queue.new
    release = Queue.new
    threads = 2.times.map do
      Thread.new do
        pool.with_connection do |connection|
          entered << connection
          release.pop
        end
      end
    end

    connections = 2.times.map { entered.pop }
    expect(connections.map(&:id).uniq.length).to eq(2)
    2.times { release << true }
    threads.each(&:join)
  end

  it 'raises when no connection becomes available before the checkout timeout' do
    pool = described_class.new(size: 1, checkout_timeout: 0.02) { Connection.new(1) }
    entered = Queue.new
    release = Queue.new
    holder = Thread.new do
      pool.with_connection do
        entered << true
        release.pop
      end
    end
    entered.pop

    expect { pool.with_connection { nil } }.to raise_error(described_class::CheckoutTimeout)
  ensure
    release << true if release
    holder.join if holder
  end

  it 'keeps concurrent repository transactions on separate connections' do
    connections = []
    pool = described_class.new(size: 2, checkout_timeout: 0.1) do
      connection = Connection.new(connections.length + 1)
      connections << connection
      connection
    end
    repository = PerpLiquidation::MysqlRepository.new(connection_pool: pool)
    entered = Queue.new
    release = Queue.new
    threads = 2.times.map do |index|
      Thread.new do
        repository.with_transaction do
          repository.with_connection { |connection| connection.query("WORK #{index}") }
          entered << true
          release.pop
        end
      end
    end
    2.times { entered.pop }
    2.times { release << true }
    threads.each(&:value)

    expect(connections.map(&:queries)).to all(satisfy do |queries|
      queries.first == 'START TRANSACTION' && queries.last == 'COMMIT' && queries.grep(/WORK/).one?
    end)
  end
end
