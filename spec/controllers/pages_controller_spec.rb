require 'spec_helper'

describe PagesController do
  render_views

  before(:each) do
    @base_title = "nullsix | "
  end

  describe "GET 'home'" do

    before(:each) do
      get :home
    end
    it "should be successful" do
      response.should be_success
    end

    it "should have the right title" do
      response.should have_selector("title",
                                    :content => "#{@base_title}Home")
    end
  end

  describe "GET 'contact'" do

    before(:each) do
      get :contact
    end

    it "should be successful" do
      response.should be_success
    end

    it "should have the right title" do
      response.should have_selector("title",
                                    :content => "#{@base_title}Contact")
    end
  end

end
