# frozen_string_literal: true

require_relative 'lib/perp_liquidation'

application = PerpLiquidation::Application.new
run application.rack_app
