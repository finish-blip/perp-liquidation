# frozen_string_literal: true

require 'puma'

describe 'Runtime security baseline' do
  it 'runs on the supported Ruby generation' do
    expect(Gem::Version.new(RUBY_VERSION)).to be >= Gem::Version.new('3.3.0')
  end

  it 'uses a Puma release that fixes the PROXY Protocol vulnerabilities' do
    expect(Gem::Version.new(Puma::Const::PUMA_VERSION)).to be >= Gem::Version.new('7.2.1')
  end
end
